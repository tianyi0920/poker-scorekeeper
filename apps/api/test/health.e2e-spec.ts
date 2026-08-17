import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';

describe('health endpoint', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule);
    app.setGlobalPrefix('api');
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
