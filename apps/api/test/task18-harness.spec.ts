import { readTestDatabaseEnvironment } from '../../../tests/e2e/support/database.js';
import { ownedAvatarFileName } from '../../../tests/e2e/support/avatar-cleanup.js';
import { assertRestoredHistoryPayload } from '../../../scripts/database/assert-restored-api.mjs';
import { waitForFreshServer } from '../../../tests/e2e/support/restart.js';
import { runSettingsOwnershipCleanup } from '../../../tests/e2e/support/settings-ownership.js';
import playwrightConfiguration from '../../../playwright.config.js';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('Task18 release harness safety', () => {
  it('replaces a poisoned parent DATABASE_URL with the guarded .env.local test target', async () => {
    // Break caught: Playwright's API process inherits an unrelated parent DATABASE_URL.
    const previous = process.env.DATABASE_URL;
    const previousDirectory = process.cwd();
    let testDirectory: string | undefined;
    try {
      testDirectory = await mkdtemp(join(tmpdir(), 'poker-task18-environment-'));
      const guardedDatabaseUrl = [
        'mysql://fixture_user:fixture_password@',
        'tianyi.wiki:8306/',
        'poker_scorekeeper_test'
      ].join('');
      await writeFile(join(testDirectory, '.env.local'), `DATABASE_URL=${guardedDatabaseUrl}\n`);
      process.env.DATABASE_URL = 'mysql://poisoned:poisoned@127.0.0.1:3306/not_the_test_database';
      process.chdir(testDirectory);
      await readTestDatabaseEnvironment();
      expect(process.env.DATABASE_URL).toBe(guardedDatabaseUrl);
      const effective = new URL(process.env.DATABASE_URL!);
      expect({
        protocol: effective.protocol,
        hostname: effective.hostname,
        port: effective.port,
        pathname: effective.pathname
      }).toEqual({
        protocol: 'mysql:',
        hostname: 'tianyi.wiki',
        port: '8306',
        pathname: '/poker_scorekeeper_test'
      });
    } finally {
      process.chdir(previousDirectory);
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      if (testDirectory !== undefined) {
        await rm(testDirectory, { recursive: true, force: true });
      }
    }
  });

  it('accepts only direct-child UUID uploads owned by the current fixture user allowlist', () => {
    // Break caught: a poisoned users.avatar_value can delete another direct child or a nested path.
    const fixtureIds = new Set(['t18-run-player']);
    const owned = 't18-run-player-01234567-89ab-4cde-8fab-0123456789ab.webp';
    expect(ownedAvatarFileName('t18-run-player', owned, fixtureIds)).toBe(owned);
    for (const candidate of [
      'other-user-01234567-89ab-4cde-8fab-0123456789ab.webp',
      't18-run-player-01234567-89ab-1cde-8fab-0123456789ab.webp',
      '../t18-run-player-01234567-89ab-4cde-8fab-0123456789ab.webp',
      'nested/t18-run-player-01234567-89ab-4cde-8fab-0123456789ab.webp'
    ]) {
      expect(ownedAvatarFileName('t18-run-player', candidate, fixtureIds)).toBeUndefined();
    }
    expect(ownedAvatarFileName('not-allowlisted', owned, fixtureIds)).toBeUndefined();
  });

  it('requires restored history to expose both participants and every exact settlement amount', () => {
    // Break caught: the restore gate accepts a reachable server whose history is partial or from another image/database.
    const runId = 'abc12345';
    const gameId = `t18gam${runId}`;
    const list = {
      items: [{
        gameId,
        name: `Task18 release drill ${runId}`,
        completedAt: '2026-08-19T00:00:00.000Z',
        settledByNickname: `Drill admin ${runId}`,
        final: '-20'
      }],
      nextCursor: null
    };
    const detail = {
      immutable: true,
      game: { id: gameId, name: `Task18 release drill ${runId}` },
      totals: { buyIn: '900', cashOut: '900', roomFee: '20', otherFee: '0', rake: '0', final: '-20' },
      players: [
        {
          nickname: `Drill admin ${runId}`,
          buyIn: '600', cashOut: '900', rawProfit: '300', roomFeeShare: '20',
          otherFeeShare: '0', afterFeeProfit: '280', rakeAmount: '0', finalAmount: '280'
        },
        {
          nickname: `Drill player ${runId}`,
          buyIn: '300', cashOut: '0', rawProfit: '-300', roomFeeShare: '0',
          otherFeeShare: '0', afterFeeProfit: '-300', rakeAmount: '0', finalAmount: '-300'
        }
      ]
    };

    expect(() => assertRestoredHistoryPayload(runId, list, detail)).not.toThrow();
    expect(() => assertRestoredHistoryPayload(runId, list, {
      ...detail,
      totals: { ...detail.totals, final: '-19' }
    })).toThrow('Restored history detail does not match the exact drill settlement');
  });

  it('uses the real API liveness route for Playwright startup', () => {
    // Break caught: the SPA fallback returns 200 for /health/live and can impersonate the API.
    const configuration = playwrightConfiguration as unknown as {
      webServer: { url: string };
    };
    expect(configuration.webServer).toMatchObject({
      url: 'http://127.0.0.1:3000/api/health/live'
    });
  });

  it('does not accept an old SPA response as a freshly restarted API', async () => {
    // Break caught: restart recovery treats an HTML fallback on the wrong route as API liveness.
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>old build</title>');
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP test address');
    try {
      await expect(waitForFreshServer(
        { exitCode: null },
        `http://127.0.0.1:${address.port}`,
        150
      )).rejects.toThrow('Fresh Task18 API did not become live');
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => server.close((error) => (
        error ? rejectClose(error) : resolveClose()
      )));
    }
  });

  it('retains the direct-predecessor token after failed cleanup and removes it only after a successful retry', async () => {
    // Break caught: a finally block removes the only recovery token while database cleanup is still incomplete.
    const previousRunId = process.env.TASK18_RUN_ID;
    const runId = `t18retry${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const tokenFile = resolve('test-results/task18-runtime', `settings-${runId}.json`);
    const cleanupFailure = new Error('original fixture cleanup failure');
    process.env.TASK18_RUN_ID = runId;
    await mkdir(resolve('test-results/task18-runtime'), { recursive: true });
    await writeFile(tokenFile, JSON.stringify({
      ownerId: `${runId}sa`,
      predecessor: { rakeThreshold: '11', rakeBps: 1111, version: 11, updatedById: 'external-v11' },
      owned: { rakeThreshold: '12', rakeBps: 1212, version: 12, updatedById: `${runId}sa` }
    }), { encoding: 'utf8', flag: 'wx' });
    try {
      await expect(runSettingsOwnershipCleanup(async () => {
        throw cleanupFailure;
      })).rejects.toBe(cleanupFailure);
      await expect(readFile(tokenFile, 'utf8')).resolves.toContain('external-v11');

      let retriedOwner: string | undefined;
      await runSettingsOwnershipCleanup(async (token) => {
        retriedOwner = token?.ownerId;
      });
      expect(retriedOwner).toBe(`${runId}sa`);
      await expect(readFile(tokenFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (previousRunId === undefined) delete process.env.TASK18_RUN_ID;
      else process.env.TASK18_RUN_ID = previousRunId;
      await rm(tokenFile, { force: true });
    }
  });
});
