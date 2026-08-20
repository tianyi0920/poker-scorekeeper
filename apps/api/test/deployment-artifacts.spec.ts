import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

interface ComposeService {
  build?: { args?: Record<string, string> };
  image?: string;
  restart?: string;
  ports?: unknown;
  env_file?: unknown;
  volumes?: unknown;
  read_only?: boolean;
  tmpfs?: unknown;
  healthcheck?: unknown;
  security_opt?: string[];
  cap_drop?: string[];
  environment?: Record<string, string>;
  entrypoint?: unknown;
  command?: unknown;
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
    expect(dockerfile.match(/^ARG DEPLOYMENT_ID$/gm)).toHaveLength(2);
    expect(dockerfile).toContain('node scripts/build/create-deployment-id.mjs "$DEPLOYMENT_ID"');
    expect(dockerfile).toContain('LABEL org.opencontainers.image.revision=$DEPLOYMENT_ID');
    expect(dockerfile).toContain('/app/deployment-id ./deployment-id');
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "-g", "--"');
    expect(dockerfile).not.toMatch(/FROM .*:latest/);
  });

  it('starts by deploying migrations and then replacing the shell with the API process', async () => {
    // Break caught: migrations are skipped or PID 1 does not receive termination signals.
    const entrypoint = await readRepositoryFile('scripts/docker/entrypoint.sh');

    expect(entrypoint).toContain('set -euo pipefail');
    expect(entrypoint).not.toContain('PRODUCTION_TARGET_REQUIRED');
    expect(entrypoint).toMatch(/^\s*node scripts\/database\/production-preflight\.mjs >\/dev\/null$/m);
    expect(entrypoint.indexOf('production-preflight.mjs'))
      .toBeLessThan(entrypoint.indexOf('prisma migrate deploy'));
    expect(entrypoint).toMatch(/prisma migrate deploy/);
    expect(entrypoint).toMatch(/exec node apps\/api\/dist\/main\.js/);
  });

  it('keeps the runtime independent from Corepack while preserving direct Prisma migrations', async () => {
    // Break caught: the production runtime requires pnpm/Corepack instead of the installed Prisma executable.
    const dockerfile = await readRepositoryFile('Dockerfile');
    const entrypoint = await readRepositoryFile('scripts/docker/entrypoint.sh');
    const compose = parse(await readRepositoryFile('docker-compose.test.yml')) as {
      services: { app: ComposeService };
    };
    const runtime = dockerfile.slice(dockerfile.indexOf('FROM node:24-bookworm-slim AS runtime'));

    expect(runtime).not.toMatch(/corepack|PNPM_HOME|pnpm\s/);
    expect(runtime).toContain('test -x /app/apps/api/node_modules/.bin/prisma');
    expect(runtime).not.toContain('COPY scripts ./scripts');
    expect(runtime).not.toMatch(/\.test\.ts|run-with-test-env|seed-release-drill|assert-restored/);
    // Break caught: root verifies only mode bits while the final node user cannot execute Prisma.
    expect(runtime).toMatch(
      /USER node\s+RUN test -x \/app\/apps\/api\/node_modules\/\.bin\/prisma\s+EXPOSE/
    );
    expect(entrypoint).toContain('/app/apps/api/node_modules/.bin/prisma migrate deploy');
    expect(entrypoint).not.toMatch(/\bpnpm\b|\bcorepack\b/);
    expect(compose.services.app.command).toContain(
      '/app/apps/api/node_modules/.bin/prisma migrate deploy && exec node apps/api/dist/main.js'
    );
  });

  it('publishes only the app on loopback and persists controlled application data', async () => {
    // Break caught: MySQL or the app is accidentally exposed to the LAN/WAN without the Synology proxy.
    const compose = parse(await readRepositoryFile('docker-compose.yml')) as {
      services: { app: ComposeService };
    };
    expect(Object.keys(compose.services)).toEqual(['app']);
    expect(compose.services.app.ports).toEqual(['127.0.0.1:3000:3000']);
    expect(compose.services.app.env_file).toEqual(['.env.production']);
    expect(compose.services.app.build?.args?.DEPLOYMENT_ID).toBe(
      '${DEPLOYMENT_ID:?DEPLOYMENT_ID is required}'
    );
    expect(compose.services.app.environment).not.toHaveProperty('PRODUCTION_TARGET_REQUIRED');
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
    expect(compose.services.app.build?.args?.DEPLOYMENT_ID).toBe(
      '${DEPLOYMENT_ID:-test-build-20260819}'
    );
    expect(compose.services.app.entrypoint).toEqual([]);
    expect(compose.services.app.command).toEqual([
      '/usr/bin/tini', '-g', '--', 'sh', '-c',
      '/app/apps/api/node_modules/.bin/prisma migrate deploy && exec node apps/api/dist/main.js'
    ]);
  });

  it('prevents source secrets and mutable local data from entering the build context', async () => {
    const ignore = await readRepositoryFile('.dockerignore');
    for (const pattern of ['.env', '.env.*', 'node_modules', '.worktrees', 'data', 'backups']) {
      expect(ignore.split(/\r?\n/)).toContain(pattern);
    }
    expect(ignore.split(/\r?\n/)).toContain('!.env.example');
  });

  it('provides a fixed-version registry compose bundle without a database service', async () => {
    const compose = parse(await readRepositoryFile('docker-compose.registry.yml')) as {
      services: { app: ComposeService };
    };

    expect(Object.keys(compose.services)).toEqual(['app']);
    expect(compose.services.app.build).toBeUndefined();
    expect(compose.services.app.image).toBe(
      'docker.io/tianyi920/poker-scorekeeper:${POKER_IMAGE_VERSION:?POKER_IMAGE_VERSION is required}'
    );
    expect(compose.services.app.ports).toEqual(['127.0.0.1:3000:3000']);
    expect(compose.services.app.env_file).toEqual(['.env.production']);
    expect(compose.services.app.volumes).toEqual(expect.arrayContaining([
      './data/avatars:/data/avatars',
      './data/backups:/data/backups',
      './data/restore:/data/restore'
    ]));
    expect(compose.services.app.read_only).toBe(true);
    expect(compose.services.app.cap_drop).toContain('ALL');
    expect(compose.services.app.restart).toBe('unless-stopped');
    expect(compose.services.app.tmpfs).toContain('/tmp:size=64m,mode=1777');
    expect(compose.services.app.security_opt).toContain('no-new-privileges:true');
    expect(compose.services.app.healthcheck).toMatchObject({
      test: ['CMD', 'node', 'scripts/docker/healthcheck.mjs']
    });
  });

  it('provides a secret-free Extreme Space environment template', async () => {
    const environment = await readRepositoryFile('.env.extremespace.example');

    expect(environment).toContain('POKER_IMAGE_VERSION=1.0.0');
    expect(environment).toContain('PUBLIC_ORIGIN=https://poker.example.com');
    expect(environment).toContain(
      'DATABASE_URL=mysql://poker_user:CHANGE_ME@192.168.10.248:3306/poker_scorekeeper'
    );
    expect(environment).toContain('MYSQL_HOST=192.168.10.248');
    expect(environment).toContain('MYSQL_PORT=3306');
    expect(environment).toContain('MYSQL_DATABASE=poker_scorekeeper');
    expect(environment).toContain('SESSION_SECRET=CHANGE_ME_AT_LEAST_32_RANDOM_BYTES');
    expect(environment).toContain('CSRF_SECRET=CHANGE_ME_AT_LEAST_32_RANDOM_BYTES');
    expect(environment).toContain('BOOTSTRAP_ADMIN_PASSWORD=CHANGE_ME_UNIQUE_STRONG_PASSWORD');
    expect(environment).toContain('MYSQL_PASSWORD=CHANGE_ME');
    expect(environment).not.toMatch(/mysql:\/\/[^:\s]+:(?!CHANGE_ME)[^@\s]+@/);
    expect(environment).not.toMatch(/(?:PASSWORD|SECRET)=((?!CHANGE_ME|<password>|replace_me).)+/i);
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
    const releaseHelpers = await readRepositoryFile('scripts/release/release-helpers.ps1');
    const releaseRuntime = `${release}\n${releaseHelpers}`;
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
    expect(releaseRuntime).toContain('/api/health/live');
    expect(releaseRuntime).toContain('/api/health/ready');
    expect(release.match(/Wait-ApplicationHealthy/g)).toHaveLength(3);
    expect(release).toMatch(/Assert-PortAvailable[^\r\n]+3000/);
    expect(release).toMatch(/Assert-PortAvailable[^\r\n]+3001/);
    expect(releaseRuntime).toMatch(/--env-file|--env-from-file/);
    expect(releaseRuntime).toMatch(/UnixCreateMode[\s\S]+UserRead[\s\S]+UserWrite/);
    expect(releaseRuntime).toContain('SetAccessRuleProtection($true, $false)');
    expect(release).not.toMatch(/["']-e["'][^\r\n]+(?:PASSWORD|DATABASE_URL)/);
    expect(release).not.toMatch(/(?:Invoke-External\s+\$docker|&\s+\$docker)[^\r\n]*DATABASE_URL/);
    expect(release).toMatch(/finally[\s\S]+Remove-PrivateEnvironmentFile[^\r\n]+restoreEnvironmentContext/);
    expect(release).not.toContain('ON *.*');
    expect(release).not.toMatch(/--skip|SKIP_DOCKER|continue-on-error/i);

    const dockerPreflight = release.indexOf('Assert-DockerCapabilities');
    const longLocalGate = release.indexOf("gate: pnpm install --frozen-lockfile");
    expect(dockerPreflight).toBeGreaterThanOrEqual(0);
    expect(dockerPreflight).toBeLessThan(longLocalGate);
    expect(releaseRuntime).toContain('2.34.0');

    const runbook = await readRepositoryFile('docs/deployment/synology.md');
    expect(runbook).toContain('Docker Compose 2.34.0');
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
