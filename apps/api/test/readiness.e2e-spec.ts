import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { vi } from 'vitest';
import { configureApplication } from '../src/common/security/application-security.js';
import { StructuredLogger } from '../src/common/security/structured-logger.js';
import { HealthController } from '../src/health/health.controller.js';
import { MariaDbReadinessProbe } from '../src/health/mariadb-readiness.probe.js';
import { ReadinessController } from '../src/health/readiness.controller.js';

const database = {
  check: vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
};

@Module({
  controllers: [HealthController, ReadinessController],
  providers: [
    { provide: MariaDbReadinessProbe, useValue: database }
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
    database.check.mockClear();
    await request(app.getHttpServer())
      .get('/api/health/live')
      .expect(200)
      .expect({ status: 'ok' });
    expect(database.check).not.toHaveBeenCalled();
  });

  it('reports ready only after a successful database probe', async () => {
    // Break caught: readiness says healthy without checking the database.
    database.check.mockResolvedValueOnce(undefined);
    await request(app.getHttpServer())
      .get('/api/health/ready')
      .expect(200)
      .expect({ status: 'ok', database: 'ok' });
    expect(database.check).toHaveBeenCalledOnce();
  });

  it('returns a stable 503 response when the database probe fails', async () => {
    // Break caught: database failure becomes a generic 500 or leaks driver diagnostics.
    database.check.mockRejectedValueOnce(
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
