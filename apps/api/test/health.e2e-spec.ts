import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp, getPort } from '../src/main.js';

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

  it('uses the default port when PORT is empty', () => {
    const originalPort = process.env.PORT;
    process.env.PORT = '';

    try {
      expect(getPort()).toBe(3000);
    } finally {
      if (originalPort === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = originalPort;
      }
    }
  });
});
