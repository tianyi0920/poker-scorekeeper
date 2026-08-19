import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

interface ComposeService {
  ports?: unknown;
  env_file?: unknown;
  volumes?: unknown;
  healthcheck?: unknown;
  security_opt?: string[];
  cap_drop?: string[];
  environment?: Record<string, string>;
}

async function readRepositoryFile(path: string): Promise<string> {
  return readFile(resolve(repositoryRoot, path), 'utf8');
}

describe('production deployment artifacts', () => {
  it('builds one non-root Node 24 runtime containing API, web, migrations, and production dependencies', async () => {
    // Break caught: the image builds only one half of the monorepo or needs dev dependencies at runtime.
    const dockerfile = await readRepositoryFile('Dockerfile');

    expect(dockerfile.match(/^FROM node:24-bookworm-slim AS \w+/gm)?.length).toBeGreaterThanOrEqual(2);
    expect(dockerfile).toMatch(/pnpm install --frozen-lockfile/);
    expect(dockerfile).toMatch(/pnpm (?:-r )?build/);
    expect(dockerfile).toMatch(/pnpm install --prod --frozen-lockfile/);
    expect(dockerfile).toMatch(/apps\/web\/dist/);
    expect(dockerfile).toMatch(/apps\/api\/prisma/);
    expect(dockerfile).toMatch(/apps\/api\/dist/);
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "-g", "--"');
    expect(dockerfile).not.toMatch(/FROM .*:latest/);
  });

  it('starts by deploying migrations and then replacing the shell with the API process', async () => {
    // Break caught: migrations are skipped or PID 1 does not receive termination signals.
    const entrypoint = await readRepositoryFile('scripts/docker/entrypoint.sh');

    expect(entrypoint).toContain('set -euo pipefail');
    expect(entrypoint).toMatch(/prisma migrate deploy/);
    expect(entrypoint).toMatch(/exec node apps\/api\/dist\/main\.js/);
  });

  it('publishes only the app on loopback and persists controlled application data', async () => {
    // Break caught: MySQL or the app is accidentally exposed to the LAN/WAN without the Synology proxy.
    const compose = parse(await readRepositoryFile('docker-compose.yml')) as {
      services: { app: ComposeService };
    };
    expect(Object.keys(compose.services)).toEqual(['app']);
    expect(compose.services.app.ports).toEqual(['127.0.0.1:3000:3000']);
    expect(compose.services.app.env_file).toEqual(['.env.production']);
    expect(compose.services.app.volumes).toEqual(expect.arrayContaining([
      './data/avatars:/data/avatars',
      './data/backups:/data/backups',
      './data/restore:/data/restore'
    ]));
    expect(compose.services.app.healthcheck).toMatchObject({
      test: ['CMD', 'node', 'scripts/docker/healthcheck.mjs']
    });
    expect(compose.services.app.security_opt).toContain('no-new-privileges:true');
    expect(compose.services.app.cap_drop).toContain('ALL');
  });

  it('keeps the optional smoke database isolated and unmistakably test-only', async () => {
    // Break caught: local container verification can reach the user-owned remote or production schema.
    const compose = parse(await readRepositoryFile('docker-compose.test.yml')) as {
      services: { app: ComposeService; mysql: ComposeService };
    };
    expect(Object.keys(compose.services).sort()).toEqual(['app', 'mysql']);
    expect(compose.services.mysql.ports).toBeUndefined();
    expect(compose.services.app.ports).toEqual(['127.0.0.1:3000:3000']);
    const databaseUrl = compose.services.app.environment?.DATABASE_URL;
    expect(databaseUrl).toBeDefined();
    expect(databaseUrl).toContain('@mysql:3306/poker_scorekeeper_test');
    expect(databaseUrl).not.toMatch(/tianyi\.wiki|192\.168\.10\.248|poker_scorekeeper(?:\?|$)/);
    expect(compose.services.mysql.environment?.MYSQL_DATABASE).toBe('poker_scorekeeper_test');
  });

  it('prevents source secrets and mutable local data from entering the build context', async () => {
    const ignore = await readRepositoryFile('.dockerignore');
    for (const pattern of ['.env', '.env.*', 'node_modules', '.worktrees', 'data', 'backups']) {
      expect(ignore.split(/\r?\n/)).toContain(pattern);
    }
    expect(ignore.split(/\r?\n/)).toContain('!.env.example');
  });

  it('keeps Linux deployment scripts and Node modules checked out with LF endings on Windows', async () => {
    // Break caught: core.autocrlf converts Docker runtime scripts to CRLF, which breaks Linux shell parsing.
    const attributes = await readRepositoryFile('.gitattributes');
    for (const rule of ['*.sh text eol=lf', '*.mjs text eol=lf', '*.mts text eol=lf']) {
      expect(attributes.split(/\r?\n/)).toContain(rule);
    }

    const runtimeFiles = [
      'scripts/docker/entrypoint.sh',
      'scripts/backup/backup.sh',
      'scripts/backup/restore.sh',
      'scripts/docker/healthcheck.mjs',
      'scripts/backup/restore-input-guard.mjs',
      'scripts/backup/restore-input-guard.d.mts'
    ];
    for (const path of runtimeFiles) {
      expect(await readFile(resolve(repositoryRoot, path))).not.toContain(0x0d);
    }
  });

  it('documents Synology production and remote-test database hosts using placeholders only', async () => {
    // Break caught: a real database credential is copied into an image, compose file, or runbook.
    const paths = [
      '.env.example',
      'docker-compose.yml',
      'docker-compose.test.yml',
      'docs/deployment/synology.md',
      'docs/deployment/backup-restore.md'
    ];
    const artifacts = (await Promise.all(paths.map(readRepositoryFile))).join('\n');
    expect(artifacts).toContain('192.168.10.248:3306');
    expect(artifacts).toContain('tianyi.wiki:8306');
    expect(artifacts).toMatch(/replace_me|<password>|CHANGE_ME/);
    expect(artifacts).not.toMatch(/mysql:\/\/[^:\s]+:(?!replace_me|<password>|CHANGE_ME)[^@\s]+@(?:tianyi\.wiki|192\.168\.10\.248)/);
  });

  it('keeps release verification fail-closed across local, browser, image, restart, backup, and restore gates', async () => {
    const release = await readRepositoryFile('scripts/verify-release.ps1');
    const rootPackage = JSON.parse(await readRepositoryFile('package.json')) as {
      packageManager: string; scripts: Record<string, string>;
    };

    expect(rootPackage.packageManager).toBe('pnpm@10.15.1');
    expect(rootPackage.scripts['verify:release']).toBe(
      'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-release.ps1'
    );
    for (const required of [
      'pnpm install --frozen-lockfile',
      'pnpm typecheck',
      'pnpm test',
      'test:integration',
      'playwright test',
      'pnpm build',
      'docker build',
      'docker compose',
      'restart app',
      'backup.sh',
      'restore.sh',
      'assert-restored-data.mjs'
    ]) expect(release).toContain(required);
    expect(release).toContain('10.15.1');
    expect(release).toContain('poker_scorekeeper_restore_test');
    expect(release).toMatch(/run-with-test-env\.mjs[^\r\n]+playwright[^\r\n]+test/);
    expect(release).toContain('assert-restored-api.mjs');
    expect(release).toContain('/api/health/live');
    expect(release).not.toContain('/api/health/ready');
    expect(release).toMatch(/Assert-PortAvailable[^\r\n]+3000/);
    expect(release).toMatch(/Assert-PortAvailable[^\r\n]+3001/);
    expect(release).toMatch(/--env-file|--env-from-file/);
    expect(release).toMatch(/SetUnixFileMode[\s\S]+UserRead[\s\S]+UserWrite/);
    expect(release).toContain('SetAccessRuleProtection($true, $false)');
    expect(release).not.toMatch(/["']-e["'][^\r\n]+(?:PASSWORD|DATABASE_URL)/);
    expect(release).not.toMatch(/(?:Invoke-External\s+\$docker|&\s+\$docker)[^\r\n]*DATABASE_URL/);
    expect(release).toMatch(/finally[\s\S]+Remove-Item[^\r\n]+restoreEnvironmentFile/);
    expect(release).not.toContain('ON *.*');
    expect(release).not.toMatch(/--skip|SKIP_DOCKER|continue-on-error/i);
  });

  it('asserts restored completed history and uploaded avatar only in the exact isolated restore schema', async () => {
    const assertion = await readRepositoryFile('scripts/database/assert-restored-data.mjs');
    expect(assertion).toContain("poker_scorekeeper_restore_test");
    expect(assertion).toMatch(/COMPLETED/);
    expect(assertion).toMatch(/settlements/);
    expect(assertion).toMatch(/avatar_kind_snapshot/);
    expect(assertion).toMatch(/RESTORE_AVATAR_ROOT/);
    expect(assertion).not.toMatch(/DROP\s+(?:DATABASE|TABLE)|TRUNCATE|DELETE\s+FROM/i);
  });
});
