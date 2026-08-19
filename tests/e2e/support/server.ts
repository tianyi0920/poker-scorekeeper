import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readTestDatabaseEnvironment } from './database.js';

async function main(): Promise<void> {
  const { values } = await readTestDatabaseEnvironment();
  for (const [key, value] of Object.entries(values)) process.env[key] = value;

  process.env.NODE_ENV = 'test';
  process.env.PORT = '3000';
  process.env.PUBLIC_ORIGIN = 'http://127.0.0.1:3000';
  process.env.WEB_DIST_ROOT = resolve('apps/web/dist');
  process.env.AVATAR_ROOT = resolve('test-results/task18-runtime/avatars');
  process.env.CSRF_SECRET ??= 'task18-local-only-csrf-secret-0123456789abcdef';
  delete process.env.BOOTSTRAP_ADMIN_USERNAME;
  delete process.env.BOOTSTRAP_ADMIN_NICKNAME;
  delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
  delete process.env.TEST_ONLY_BOOTSTRAP_USERNAME;

  await mkdir(process.env.AVATAR_ROOT, { recursive: true });
  const { bootstrap } = await import('../../../apps/api/dist/main.js');
  await bootstrap();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Task18 server startup failed');
  process.exitCode = 1;
});
