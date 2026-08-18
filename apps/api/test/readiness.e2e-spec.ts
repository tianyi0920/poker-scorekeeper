import { Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { vi } from 'vitest';
import { configureApplication } from '../src/common/security/application-security.js';
import { StructuredLogger } from '../src/common/security/structured-logger.js';
import { HealthController } from '../src/health/health.controller.js';
import { ReadinessController } from '../src/health/readiness.controller.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const database = {
  $queryRawUnsafe: vi.fn<() => Promise<unknown>>().mockResolvedValue([{ ok: 1 }])
};

@Module({
  controllers: [HealthController, ReadinessController],
  providers: [
    { provide: PrismaService, useValue: database },
    { provide: ConfigService, useValue: { get: () => '2000' } }
  ]
})
class ReadinessTestModule {}

describe('health boundaries', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(ReadinessTestModule, {
      bodyParser: false,
      logger: false
    });
    app.setGlobalPrefix('api');
    configureApplication(app, new StructuredLogger(() => undefined));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports liveness without querying the database', async () => {
    // Break caught: an unavailable dependency incorrectly marks the process dead.
    database.$queryRawUnsafe.mockClear();
    await request(app.getHttpServer())
      .get('/api/health/live')
      .expect(200)
      .expect({ status: 'ok' });
    expect(database.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('reports ready only after a successful database probe', async () => {
    // Break caught: readiness says healthy without checking the database.
    database.$queryRawUnsafe.mockResolvedValueOnce([{ ok: 1 }]);
    await request(app.getHttpServer())
      .get('/api/health/ready')
      .expect(200)
      .expect({ status: 'ok', database: 'ok' });
    expect(database.$queryRawUnsafe).toHaveBeenCalledWith('SELECT 1');
  });

  it('returns a stable 503 response when the database probe fails', async () => {
    // Break caught: database failure becomes a generic 500 or leaks driver diagnostics.
    database.$queryRawUnsafe.mockRejectedValueOnce(
      new Error('connect mysql://user:secret@db/poker password=hidden')
    );
    const response = await request(app.getHttpServer())
      .get('/api/health/ready')
      .set('X-Request-ID', 'readiness-request')
      .expect(503);

    expect(response.body).toEqual({
      code: 'DATABASE_UNAVAILABLE',
      message: 'Database is unavailable',
      requestId: 'readiness-request'
    });
    expect(response.text).not.toContain('mysql://');
    expect(response.text).not.toContain('password=');
  });
});
