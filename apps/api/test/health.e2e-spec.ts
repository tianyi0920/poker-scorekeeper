import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/main.js';

describe('health endpoint', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health/live returns ok', async () => {
    await request(app.getHttpServer())
      .get('/api/health/live')
      .expect(200)
      .expect({ status: 'ok' });
  });
});
