import {
  Body,
  Controller,
  Get,
  Module,
  Post,
  Req,
  type INestApplication
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { badRequest } from '../src/common/errors/app-error.js';
import {
  configureApplication,
  trustProxySetting
} from '../src/common/security/application-security.js';
import { SecurityModule } from '../src/common/security/security.module.js';
import { StructuredLogger } from '../src/common/security/structured-logger.js';
import { StaticModule } from '../src/static/static.module.js';

interface RequestProbe {
  ip?: string;
  requestId?: string;
}

@Controller()
class SecurityProbeController {
  @Post('echo')
  echo(@Body() body: { payload?: string }): { length: number } {
    return { length: body.payload?.length ?? 0 };
  }

  @Get('request-info')
  requestInfo(@Req() req: RequestProbe): RequestProbe {
    return { ip: req.ip, requestId: req.requestId };
  }

  @Get('expected-error')
  expectedError(): never {
    throw badRequest('VALIDATION_ERROR');
  }

  @Get('unique-error')
  uniqueError(): never {
    throw Object.assign(new Error('INSERT INTO users password=super-secret'), {
      code: 'P2002',
      meta: { target: ['normalized_username'], databaseUrl: 'mysql://user:secret@db/internal' }
    });
  }

  @Get('deadlock-error')
  deadlockError(): never {
    throw Object.assign(new Error('Deadlock found while writing password=hidden'), {
      errno: 1213,
      sql: 'UPDATE users SET password_hash=secret'
    });
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
    SecurityModule,
    StaticModule
  ],
  controllers: [SecurityProbeController]
})
class SecurityTestModule {}

describe('production HTTP security', () => {
  let app: INestApplication;
  let fixtureRoot: string;
  let logLines: string[];
  const originalEnvironment = { ...process.env };

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'poker-security-'));
    const webRoot = join(fixtureRoot, 'web');
    const avatarRoot = join(fixtureRoot, 'avatars');
    await mkdir(join(webRoot, 'assets'), { recursive: true });
    await mkdir(join(webRoot, 'avatars'), { recursive: true });
    await mkdir(avatarRoot, { recursive: true });
    await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>safe poker shell</title>');
    await writeFile(join(webRoot, 'assets', 'app.js'), 'globalThis.pokerLoaded=true;');
    await writeFile(join(webRoot, 'avatars', 'preset-01.webp'), 'preset-avatar');
    await writeFile(
      join(avatarRoot, 'cm1234567890-123e4567-e89b-42d3-a456-426614174000.webp'),
      'uploaded-avatar'
    );

    process.env.NODE_ENV = 'production';
    process.env.PUBLIC_ORIGIN = 'https://poker.example.test';
    process.env.WEB_DIST_ROOT = webRoot;
    process.env.AVATAR_ROOT = avatarRoot;
    logLines = [];
    const logger = new StructuredLogger((line) => logLines.push(line));
    app = await NestFactory.create(SecurityTestModule, {
      bodyParser: false,
      logger: false
    });
    app.setGlobalPrefix('api');
    configureApplication(app, logger);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await rm(fixtureRoot, { recursive: true, force: true });
    process.env = originalEnvironment;
  });

  it('sets a same-origin CSP and anti-embedding headers on the PWA shell', async () => {
    // Break caught: Helmet is removed or CSP becomes wildcard/cross-origin.
    const response = await request(app.getHttpServer()).get('/').expect(200);

    expect(response.text).toContain('safe poker shell');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['content-security-policy']).toContain("connect-src 'self'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['content-security-policy']).not.toContain('*');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['strict-transport-security']).toContain('max-age=');
  });

  it('propagates a validated request ID to success and stable error responses', async () => {
    // Break caught: correlation IDs disappear between request, header, and error body.
    const success = await request(app.getHttpServer())
      .get('/api/request-info')
      .set('X-Request-ID', 'client-ABC_123')
      .expect(200);
    expect(success.headers['x-request-id']).toBe('client-ABC_123');
    expect(success.body.requestId).toBe('client-ABC_123');

    const failure = await request(app.getHttpServer())
      .get('/api/expected-error')
      .set('X-Request-ID', 'client-ABC_123')
      .expect(400);
    expect(failure.body).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Invalid request',
      requestId: 'client-ABC_123'
    });
  });

  it('replaces an invalid request ID instead of reflecting it', async () => {
    // Break caught: untrusted correlation IDs can inject log content or oversized metadata.
    const response = await request(app.getHttpServer())
      .get('/api/expected-error')
      .set('X-Request-ID', `bad request id ${'x'.repeat(160)}`)
      .expect(400);

    expect(response.body.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(response.headers['x-request-id']).toBe(response.body.requestId);
    expect(response.body.requestId).not.toContain('bad request');
  });

  it('accepts JSON below 256 KiB and returns a stable error above the limit', async () => {
    // Break caught: the intended body ceiling is absent or the parser leaks its own error.
    const acceptedPayload = 'x'.repeat(200 * 1024);
    await request(app.getHttpServer())
      .post('/api/echo')
      .send({ payload: acceptedPayload })
      .expect(201)
      .expect({ length: acceptedPayload.length });

    const rejected = await request(app.getHttpServer())
      .post('/api/echo')
      .set('X-Request-ID', 'oversize-request')
      .send({ payload: 'x'.repeat(270 * 1024) })
      .expect(413);
    expect(rejected.body).toEqual({
      code: 'REQUEST_TOO_LARGE',
      message: 'Request payload is too large',
      requestId: 'oversize-request'
    });
  });

  it('rejects an oversized URL with the same stable error envelope', async () => {
    // Break caught: arbitrarily large request targets reach routing and logs.
    const response = await request(app.getHttpServer())
      .get(`/api/request-info?probe=${'x'.repeat(2_100)}`)
      .set('X-Request-ID', 'long-url-request')
      .expect(414);
    expect(response.body).toEqual({
      code: 'URI_TOO_LONG',
      message: 'Request URI is too long',
      requestId: 'long-url-request'
    });
  });

  it('trusts one reverse-proxy hop only in production', async () => {
    // Break caught: arbitrary forwarded chains can spoof the public client address.
    expect(trustProxySetting('production')).toBe(1);
    expect(trustProxySetting('development')).toBe(false);
    expect(trustProxySetting('test')).toBe(false);

    const response = await request(app.getHttpServer())
      .get('/api/request-info')
      .set('X-Forwarded-For', '198.51.100.50, 10.0.0.9')
      .expect(200);
    expect(response.body.ip).toBe('10.0.0.9');
  });

  it.each([
    ['/api/not-a-client-route', 'application/json'],
    ['/socket.io/not-a-client-route', 'application/json'],
    ['/avatars/not-a-client-route', 'application/json']
  ])('does not let SPA fallback swallow reserved path %s', async (path, contentType) => {
    // Break caught: an API, Socket.IO, or avatar miss is hidden behind index.html.
    const response = await request(app.getHttpServer()).get(path).expect(404);
    expect(response.headers['content-type']).toContain(contentType);
    expect(response.body.code).toBe('NOT_FOUND');
    expect(response.text).not.toContain('safe poker shell');
  });

  it('serves built assets, SPA routes, preset avatars, and controlled upload files', async () => {
    // Break caught: the single container omits one of its four static delivery paths.
    await request(app.getHttpServer()).get('/assets/app.js').expect(200).expect('globalThis.pokerLoaded=true;');
    await request(app.getHttpServer()).get('/history/games').expect(200).expect(/safe poker shell/);
    await request(app.getHttpServer()).get('/avatars/preset-01.webp').expect(200).expect('preset-avatar');
    await request(app.getHttpServer())
      .get('/avatars/uploads/cm1234567890-123e4567-e89b-42d3-a456-426614174000.webp')
      .expect(200)
      .expect('uploaded-avatar');
  });

  it('does not expose traversal-shaped or uncontrolled avatar paths', async () => {
    // Break caught: a crafted avatar URL reads outside the persistent avatar directory.
    const response = await request(app.getHttpServer())
      .get('/avatars/uploads/%2e%2e%2fweb%2findex.html')
      .expect(404);
    expect(response.text).not.toContain('safe poker shell');
  });

  it('maps Prisma uniqueness and deadlocks without leaking SQL or secrets', async () => {
    // Break caught: ORM/driver diagnostics escape to clients or production logs.
    const unique = await request(app.getHttpServer())
      .get('/api/unique-error')
      .set('X-Request-ID', 'unique-request')
      .expect(409);
    expect(unique.body).toEqual({
      code: 'RESOURCE_CONFLICT',
      message: 'Resource already exists',
      requestId: 'unique-request'
    });

    const deadlock = await request(app.getHttpServer())
      .get('/api/deadlock-error')
      .set('X-Request-ID', 'deadlock-request')
      .expect(503);
    expect(deadlock.body).toEqual({
      code: 'DATABASE_BUSY',
      message: 'Database is busy; retry the request',
      requestId: 'deadlock-request'
    });

    const captured = logLines.join('\n');
    expect(captured).toContain('unique-request');
    expect(captured).toContain('deadlock-request');
    expect(captured).not.toContain('INSERT INTO');
    expect(captured).not.toContain('password=');
    expect(captured).not.toContain('mysql://');
    expect(captured).not.toContain('super-secret');
  });
});
