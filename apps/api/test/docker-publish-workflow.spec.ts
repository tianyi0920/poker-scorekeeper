import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

async function readRepositoryFile(path: string) {
  return readFile(resolve(repositoryRoot, path), 'utf8');
}

describe('candidate-image smoke contract', () => {
  it('fails closed around one isolated candidate image', async () => {
    // Break caught: a candidate smoke can accidentally start an arbitrary image or share a Compose project.
    const script = await readRepositoryFile('scripts/ci/verify-candidate-image.sh');

    expect(script).toContain('${POKER_TEST_IMAGE:?');
    expect(script).toMatch(/\[\[\s+!\s+"\$COMPOSE_PROJECT_NAME"\s+=~\s+\^poker-candidate-\[a-f0-9\]\{12\}\$\s+\]\]/);
    expect(script).toContain('docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.test.yml');
    expect(script).toContain('up -d --no-build');
    expect(script).toContain('down -v --remove-orphans');
    expect(script).toMatch(/trap cleanup EXIT/);
  });

  it('probes negative migration before healthy startup and keeps all endpoints local', async () => {
    // Break caught: a bad database credential can be masked by a successful startup or a remote endpoint.
    const script = await readRepositoryFile('scripts/ci/verify-candidate-image.sh');

    expect(script).toContain('poker_invalid');
    expect(script).toContain('/app/apps/api/node_modules/.bin/prisma migrate deploy');
    expect(script).toContain('/api/health/live');
    expect(script).toContain('/api/health/ready');
    expect(script).toMatch(/if\s+"\$\{compose\[@\]\}"\s+run[\s\S]*then/);
    expect(script.indexOf('poker_invalid')).toBeLessThan(script.indexOf('run --rm --no-deps'));
    expect(script).toContain("base_url='http://127.0.0.1:3000'");
    expect(script).not.toMatch(/(?:tianyi\.wiki|x\.tianyi\.wiki|https?:\/\/[^\s"']*(?:production|remote))/i);
  });

  it('checks hardened runtime state and named-volume persistence', async () => {
    // Break caught: a candidate can become root, writable at its root filesystem, or lose durable user data on restart.
    const script = await readRepositoryFile('scripts/ci/verify-candidate-image.sh');

    expect(script).toContain('id -u');
    expect(script).toContain('ReadonlyRootfs');
    expect(script).toContain('/data/avatars');
    expect(script).toContain('/data/backups');
    expect(script).toContain('restart app');
    expect(script).toMatch(/avatar-marker-\$\{marker\}/);
    expect(script).toMatch(/backup-marker-\$\{marker\}/);
  });

  it('uses production-like filesystem and privilege restrictions in test Compose', async () => {
    // Break caught: the candidate smoke does not exercise the image under the restrictions used in production.
    const compose = parse(await readRepositoryFile('docker-compose.test.yml')) as {
      services: { app: Record<string, unknown> };
    };

    expect(compose.services.app.read_only).toBe(true);
    expect(compose.services.app.tmpfs).toContain('/tmp:size=64m,mode=1777');
    expect(compose.services.app.security_opt).toContain('no-new-privileges:true');
    expect(compose.services.app.cap_drop).toContain('ALL');
    expect(compose.services.app.entrypoint).toEqual([]);
    expect(compose.services.app.command).toContain('/app/apps/api/node_modules/.bin/prisma migrate deploy && exec node apps/api/dist/main.js');
  });
});
