import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { pathToFileURL } from 'node:url';
import 'reflect-metadata';
import { AppModule } from './app.module.js';
import { configureApplication } from './common/security/application-security.js';
import { StructuredLogger } from './common/security/structured-logger.js';

export async function createApp(): Promise<INestApplication> {
  const logger = new StructuredLogger();
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger });
  app.setGlobalPrefix('api');
  configureApplication(app, logger);
  app.enableShutdownHooks();
  return app;
}

export function getPort(): string | number {
  return process.env.PORT || 3000;
}

export async function bootstrap(): Promise<void> {
  const app = await createApp();
  await app.listen(getPort(), '0.0.0.0');
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void bootstrap();
}
