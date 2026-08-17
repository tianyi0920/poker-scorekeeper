import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import 'reflect-metadata';
import { AppModule } from './app.module.js';

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  return app;
}

async function bootstrap(): Promise<void> {
  const app = await createApp();
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}

void bootstrap();
