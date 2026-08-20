import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const windowsOnly = process.platform === 'win32' ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, '../../..');
const releasePath = resolve(repositoryRoot, 'scripts/verify-release.ps1');

windowsOnly('Task19 release deployment identity', () => {
  it('starts the isolated container drill without pinned pnpm or local database gates', async () => {
    // Break caught: hosted container verification reads .env.local or runs remote test gates before Docker.
    const root = await mkdtemp(join(tmpdir(), 'task19-container-only-'));
    const dockerLog = join(root, 'docker.log');
    const revision = '0123456789abcdef0123456789abcdef01234567';
    try {
      await writeFile(join(root, 'node.cmd'), [
        '@echo off',
        'exit /b 96'
      ].join('\r\n'));
      await writeFile(join(root, 'git.cmd'), [
        '@echo off',
        `if "%3 %4 %5"=="rev-parse --verify HEAD" (echo ${revision}& exit /b 0)`,
        'exit /b 91'
      ].join('\r\n'));
      await writeFile(join(root, 'docker.cmd'), [
        '@echo off',
        'if "%1"=="version" (exit /b 0)',
        'if "%1 %2"=="buildx version" (exit /b 0)',
        'if "%1 %2 %3"=="compose version --short" (echo 2.34.0& exit /b 0)',
        'if "%1"=="build" (echo ARGS=%*>>"%TEST_RELEASE_DOCKER_LOG%"& exit /b 0)',
        'if "%1"=="compose" (echo ARGS=%*>>"%TEST_RELEASE_DOCKER_LOG%"& exit /b 87)',
        'exit /b 92'
      ].join('\r\n'));

      const environment = { ...process.env };
      delete environment.npm_execpath;
      environment.PATH = `${root};${process.env.PATH ?? ''}`;
      environment.TEST_RELEASE_DOCKER_LOG = dockerLog;
      const result = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', releasePath, '-ContainerOnly'
      ], {
        cwd: repositoryRoot,
        env: environment,
        encoding: 'utf8'
      });

      expect(result.status).not.toBe(0);
      const log = await readFile(dockerLog, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      expect(log).toMatch(/^ARGS=build --build-arg DEPLOYMENT_ID=releaseverify-/m);
      expect(log).toMatch(/^ARGS=compose .* config --quiet$/m);
      expect(`${result.stdout}\n${result.stderr}`).not.toMatch(
        /pinned pnpm|run-with-test-env|\.env\.local/
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('derives one auditable non-secret ID and passes it to direct and Compose builds', async () => {
    // Break caught: the release image build omits DEPLOYMENT_ID or trusts a poisoned parent value.
    const root = await mkdtemp(join(tmpdir(), 'task19-release-id-'));
    const dockerLog = join(root, 'docker.log');
    const revision = '0123456789abcdef0123456789abcdef01234567';
    try {
      await writeFile(join(root, 'node.cmd'), [
        '@echo off',
        'if "%2"=="--version" (echo 10.15.1& exit /b 0)',
        'exit /b 0'
      ].join('\r\n'));
      await writeFile(join(root, 'git.cmd'), [
        '@echo off',
        `if "%3 %4 %5"=="rev-parse --verify HEAD" (echo ${revision}& exit /b 0)`,
        'exit /b 91'
      ].join('\r\n'));
      await writeFile(join(root, 'docker.cmd'), [
        '@echo off',
        'if "%1"=="version" (exit /b 0)',
        'if "%1 %2"=="buildx version" (exit /b 0)',
        'if "%1 %2 %3"=="compose version --short" (echo 2.34.0& exit /b 0)',
        'if "%1"=="build" (echo ID=%DEPLOYMENT_ID% ARGS=%*>>"%TEST_RELEASE_DOCKER_LOG%"& exit /b 0)',
        'if "%1"=="compose" (echo ID=%DEPLOYMENT_ID% ARGS=%*>>"%TEST_RELEASE_DOCKER_LOG%"& exit /b 87)',
        'exit /b 92'
      ].join('\r\n'));
      const pnpmCli = join(root, 'pnpm.cjs');
      await writeFile(pnpmCli, '');

      const result = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', releasePath
      ], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PATH: `${root};${process.env.PATH ?? ''}`,
          npm_execpath: pnpmCli,
          TEST_RELEASE_DOCKER_LOG: dockerLog,
          DEPLOYMENT_ID: 'attacker-parent-value',
          SESSION_SECRET: 'fake-secret-must-not-leak'
        },
        encoding: 'utf8'
      });

      expect(result.status).not.toBe(0);
      const log = await readFile(dockerLog, 'utf8');
      const build = new RegExp(
        `^ID=(releaseverify-${revision}-[a-f0-9]{8}) ` +
        'ARGS=build --build-arg DEPLOYMENT_ID=([^ ]+) -t poker-scorekeeper:verify \\.$',
        'm'
      ).exec(log);
      expect(build).not.toBeNull();
      const expectedId = build?.[1] ?? '';
      expect(build?.[2]).toBe(expectedId);
      expect(expectedId).toMatch(/^[a-z0-9][a-z0-9._-]{7,63}$/);
      expect(log).toMatch(
        new RegExp(`ID=${expectedId} ARGS=compose .* config --quiet`)
      );
      expect(log).not.toMatch(/attacker-parent-value|fake-secret-must-not-leak/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
