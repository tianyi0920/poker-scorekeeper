import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { readTestDatabaseEnvironment } from './database.js';

export async function waitForFreshServer(
  child: Pick<ChildProcess, 'exitCode'>,
  baseURL: string,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Fresh Task18 API exited with status ${child.exitCode}`);
    try {
      const response = await fetch(`${baseURL}/api/health/live`, {
        headers: { Accept: 'application/json' }
      });
      const contentType = response.headers.get('content-type') ?? '';
      if (response.ok && contentType.includes('application/json')) {
        const body = await response.json() as { status?: unknown };
        if (body.status === 'ok') return;
      }
    } catch {
      // The process is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error('Fresh Task18 API did not become live within 30 seconds');
}

export async function startFreshApi(port: number): Promise<{ baseURL: string; stop(): Promise<void> }> {
  const { values } = await readTestDatabaseEnvironment();
  const environment = { ...process.env, ...values };
  environment.NODE_ENV = 'test';
  environment.PORT = String(port);
  environment.PUBLIC_ORIGIN = `http://127.0.0.1:${port}`;
  environment.WEB_DIST_ROOT = resolve('apps/web/dist');
  environment.AVATAR_ROOT = resolve('test-results/task18-runtime/avatars');
  environment.CSRF_SECRET ??= 'task18-local-only-csrf-secret-0123456789abcdef';
  delete environment.BOOTSTRAP_ADMIN_USERNAME;
  delete environment.BOOTSTRAP_ADMIN_NICKNAME;
  delete environment.BOOTSTRAP_ADMIN_PASSWORD;
  delete environment.TEST_ONLY_BOOTSTRAP_USERNAME;

  const child = spawn(process.execPath, [resolve('apps/api/dist/main.js')], {
    cwd: process.cwd(),
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout?.resume();
  child.stderr?.resume();
  const baseURL = `http://127.0.0.1:${port}`;
  await waitForFreshServer(child, baseURL);
  return {
    baseURL,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise<void>((resolveStop, rejectStop) => {
        const timeout = setTimeout(() => rejectStop(new Error('Fresh Task18 API did not stop')), 10_000);
        child.once('exit', () => { clearTimeout(timeout); resolveStop(); });
        child.once('error', (error) => { clearTimeout(timeout); rejectStop(error); });
      });
    }
  };
}
