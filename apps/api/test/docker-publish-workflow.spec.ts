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
    // Break caught: a candidate smoke can pull or run an image that was not built for the expected commit.
    const script = await readRepositoryFile('scripts/ci/verify-candidate-image.sh');

    expect(script).toContain('${POKER_TEST_IMAGE:?');
    expect(script).toContain('${EXPECTED_COMMIT:?');
    expect(script).toMatch(/\[\[\s+!\s+"\$EXPECTED_COMMIT"\s+=~\s+\^\[a-f0-9\]\{40\}\$\s+\]\]/);
    expect(script).toContain('candidate_image_pattern="^poker-scorekeeper:candidate-${EXPECTED_COMMIT}-[a-f0-9]{8}$"');
    expect(script).toMatch(/\[\[\s+!\s+"\$POKER_TEST_IMAGE"\s+=~\s+\$candidate_image_pattern\s+\]\]/);
    expect(script).toMatch(/docker image inspect --format '\{\{ index \.Config\.Labels "org\.opencontainers\.image\.revision" \}\}' "\$POKER_TEST_IMAGE"/);
    expect(script).toMatch(/\[\[\s+"\$image_revision"\s+==\s+"\$EXPECTED_COMMIT"\s+\]\]/);
    expect(script.indexOf('docker image inspect')).toBeLessThan(script.indexOf('compose=('));
    expect(script).toMatch(/\[\[\s+!\s+"\$COMPOSE_PROJECT_NAME"\s+=~\s+\^poker-candidate-\[a-f0-9\]\{12\}\$\s+\]\]/);
    expect(script).toContain('docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.test.yml');
    expect(script).toContain('up -d --pull never --no-build');
    const cleanup = script.match(/cleanup\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(cleanup).toContain('"${compose[@]}" down -v --remove-orphans');
    expect(script).toMatch(/trap cleanup EXIT/);
  });

  it('probes negative migration before healthy startup and keeps all endpoints local', async () => {
    // Break caught: a bad database credential starts the API, hangs forever, or is confused with another local listener.
    const script = await readRepositoryFile('scripts/ci/verify-candidate-image.sh');

    const negativeProbeStart = script.indexOf('timeout 30s "${compose[@]}" run');
    const negativeProbeEnd = script.indexOf('assert_app_absent', negativeProbeStart);
    const negativeProbe = script.slice(negativeProbeStart, negativeProbeEnd);
    expect(negativeProbe).toContain('-e "DATABASE_URL=$invalid_database_url"');
    expect(negativeProbe).toContain('app /app/apps/api/node_modules/.bin/prisma migrate deploy');
    expect(negativeProbe).not.toContain('node apps/api/dist/main.js');
    expect(negativeProbe).not.toContain('--service-ports');
    expect(negativeProbe).toContain('migration_status=$?');
    expect(negativeProbe).toMatch(/\(\( migration_status == 0 \)\)/);
    expect(negativeProbe).toMatch(/\(\( migration_status == 124 \)\)/);
    const mysqlStart = script.indexOf('"${compose[@]}" up -d --pull never --no-build mysql');
    expect(script.lastIndexOf('assert_port_unused', mysqlStart)).toBeLessThan(mysqlStart);
    expect(script).toMatch(/timeout 2s bash -c 'exec 3<>\/dev\/tcp\/127\.0\.0\.1\/3000'/);
    const absenceProbe = script.match(/assert_app_absent\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(absenceProbe).toContain('"${compose[@]}" ps -q app');
    expect(absenceProbe).toContain('curl --fail --silent --show-error --connect-timeout 1 "$base_url/api/health/live"');
    expect(script.indexOf('assert_app_absent', negativeProbeStart + 1)).toBeGreaterThan(negativeProbeStart);
    expect(script).toContain('/api/health/live');
    expect(script).toContain('/api/health/ready');
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
    const restart = script.indexOf('"${compose[@]}" restart app');
    expect(script.indexOf('> /data/avatars/avatar-marker-${marker}')).toBeLessThan(restart);
    expect(script.indexOf('> /data/backups/backup-marker-${marker}')).toBeLessThan(restart);
    expect(script.indexOf('cat /data/avatars/avatar-marker-${marker}')).toBeGreaterThan(restart);
    expect(script.indexOf('cat /data/backups/backup-marker-${marker}')).toBeGreaterThan(restart);
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
    expect(compose.services.app.pull_policy).toBe('never');
    expect(compose.services.app.entrypoint).toEqual([]);
    expect(compose.services.app.command).toContain('/app/apps/api/node_modules/.bin/prisma migrate deploy && exec node apps/api/dist/main.js');
  });
});
