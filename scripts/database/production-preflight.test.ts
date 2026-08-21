import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  assertProductionEnvironment,
  assertProductionTarget,
  executeProductionPreflightCli,
  runProductionPreflight
} from './production-preflight.mjs';
import {
  assertPublicOrigin,
  collectRepositoryMigrationEvidence,
  formatProductionVerificationRecord,
  joinProductionSpectator,
  runProductionAcceptance,
  runProductionVerification,
  writeProductionVerificationRecord
} from '../verify-production.mjs';
import { readProductionMigrationEvidence } from './production-migration-evidence.mjs';
import { assertProductionBackupTarget } from './production-backup-target.mjs';

const productionUrl = 'mysql://preflight_user:never-print-me@192.168.10.248:3306/poker_scorekeeper';
const responseTime = '2026-08-19T09:30:00.000Z';

function authResponse(username: string, mustChangePassword: boolean, csrf = 'a'.repeat(64)) {
  return {
    user: {
      id: 'admin-id', username, nickname: 'Admin', role: 'SUPER_ADMIN', mustChangePassword
    },
    csrfToken: csrf
  };
}

function userResponse(
  id: string,
  username = 'accept-abc123def456',
  nickname = '验收-abc123def456',
  deleted = false
) {
  return {
    id, username, nickname, role: 'USER', rakeEnabled: false,
    avatarKind: 'PRESET', avatarValue: 'preset-01',
    isActive: !deleted, mustChangePassword: true,
    deletedAt: deleted ? responseTime : null,
    createdAt: responseTime, updatedAt: responseTime
  };
}

function gameResponse(id: string, status: string, name = '生产验收-abc123def456') {
  return {
    id, name, status, version: status === 'DRAFT' ? 1 : status === 'ACTIVE' ? 2 : 3,
    handPrice: '300', rakeEnabled: false,
    startedAt: status === 'DRAFT' ? null : responseTime,
    stoppedAt: status === 'VOIDED' ? responseTime : null,
    serverNow: responseTime, players: [], purchases: [], spectators: []
  };
}

function acceptanceReport() {
  return {
    acceptanceResult: 'PASS', healthResult: 'PASS', loginResult: 'PASS', csrfResult: 'PASS',
    passwordChangeResult: 'PASS', userCreationResult: 'PASS', gameStartResult: 'PASS',
    websocketPresenceResult: 'PASS', gameVoidResult: 'PASS', userLogicalDeleteResult: 'PASS',
    acceptanceTimestamp: responseTime
  };
}

function verificationEvidence() {
  const stamp = '20260819T093000Z';
  return {
    deploymentId: 'deploy-20260819-abc123',
    imageDigest: `sha256:${'1'.repeat(64)}`,
    migrationVersion: '20260818000100_settlement_settler_snapshot',
    migrationChecksum: '5'.repeat(64),
    migrationResult: 'PASS',
    healthResult: 'PASS',
    backupResult: 'PASS',
    acceptanceResult: 'PASS',
    backupStamp: stamp,
    backupFiles: [
      { name: `mysql-${stamp}.sql.gz`, sha256: '2'.repeat(64) },
      { name: `avatars-${stamp}.tar.gz`, sha256: '3'.repeat(64) },
      { name: `manifest-${stamp}.txt`, sha256: '4'.repeat(64) }
    ],
    acceptanceTimestamp: responseTime
  };
}

function fakeConnector(options: {
  databaseExists: boolean;
  grants: string[];
  useDenied?: boolean;
}) {
  const queries: string[] = [];
  const connectionOptions: Array<Record<string, unknown>> = [];
  let selectedDatabase: string | null = null;
  let ended = false;

  return {
    queries,
    connectionOptions,
    get ended() { return ended; },
    connect: async (received: Record<string, unknown>) => {
      connectionOptions.push(received);
      return {
        query: async (sql: string) => {
          queries.push(sql);
          if (/^SELECT VERSION\(\)/.test(sql)) {
            return [{ serverVersion: '11.4.5-MariaDB', currentDatabase: selectedDatabase }];
          }
          if (/CHARACTER_SETS/.test(sql)) return [{ utf8mb4Count: 1 }];
          if (/SCHEMATA/.test(sql)) return [{ databaseCount: options.databaseExists ? 1 : 0 }];
          if (/^SHOW GRANTS FOR CURRENT_USER/.test(sql)) {
            return options.grants.map((grant, index) => ({ [`grant${index}`]: grant }));
          }
          if (/^USE `poker_scorekeeper`$/.test(sql)) {
            if (options.useDenied) throw new Error('permission denied with never-print-me');
            selectedDatabase = 'poker_scorekeeper';
            return [];
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
        end: async () => { ended = true; }
      };
    }
  };
}

describe('production target validation', () => {
  it('rejects every image-provided placeholder before contacting production', async () => {
    // Break caught: an operator can start with a long but public example secret from image metadata.
    const configured = {
      PUBLIC_ORIGIN: 'https://poker.example.com',
      DATABASE_URL: 'mysql://poker_user:CHANGE_ME@192.168.10.248:3306/poker_scorekeeper',
      SESSION_SECRET: 'CHANGE_ME_AT_LEAST_32_RANDOM_BYTES',
      CSRF_SECRET: 'CHANGE_ME_AT_LEAST_32_RANDOM_BYTES',
      BOOTSTRAP_ADMIN_NICKNAME: 'CHANGE_ME_ADMIN_NICKNAME',
      BOOTSTRAP_ADMIN_PASSWORD: 'CHANGE_ME_UNIQUE_STRONG_PASSWORD',
      MYSQL_PASSWORD: 'CHANGE_ME'
    };

    for (const key of Object.keys(configured)) {
      expect(() => assertProductionEnvironment({
        ...configured,
        PUBLIC_ORIGIN: 'https://poker.example.net',
        DATABASE_URL: productionUrl,
        SESSION_SECRET: 's'.repeat(64),
        CSRF_SECRET: 'c'.repeat(64),
        BOOTSTRAP_ADMIN_NICKNAME: '管理员',
        BOOTSTRAP_ADMIN_PASSWORD: 'Unique-Admin-Password-123!',
        MYSQL_PASSWORD: 'backup-password',
        [key]: configured[key as keyof typeof configured]
      })).toThrow('PRODUCTION_CONFIGURATION_PLACEHOLDER');
    }

    expect(() => assertProductionEnvironment({
      PUBLIC_ORIGIN: 'https://poker.example.net',
      DATABASE_URL: productionUrl,
      SESSION_SECRET: 's'.repeat(64),
      CSRF_SECRET: 'c'.repeat(64),
      BOOTSTRAP_ADMIN_NICKNAME: '管理员',
      BOOTSTRAP_ADMIN_PASSWORD: 'Unique-Admin-Password-123!',
      MYSQL_PASSWORD: 'backup-password'
    })).not.toThrow();

    const preflight = vi.fn();
    await expect(executeProductionPreflightCli(configured, preflight)).resolves.toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'PRODUCTION_CONFIGURATION_PLACEHOLDER\n'
    });
    expect(preflight).not.toHaveBeenCalled();

    const validEnvironment = {
      PUBLIC_ORIGIN: 'https://poker.example.net',
      DATABASE_URL: productionUrl,
      SESSION_SECRET: 's'.repeat(64),
      CSRF_SECRET: 'c'.repeat(64),
      BOOTSTRAP_ADMIN_NICKNAME: '管理员',
      BOOTSTRAP_ADMIN_PASSWORD: 'Unique-Admin-Password-123!',
      MYSQL_PASSWORD: 'backup-password'
    };
    const validPreflight = vi.fn().mockResolvedValue({ databaseExists: true });
    await expect(executeProductionPreflightCli(validEnvironment, validPreflight)).resolves.toEqual({
      exitCode: 0,
      stdout: '{"databaseExists":true}\n',
      stderr: ''
    });
    expect(validPreflight).toHaveBeenCalledWith(productionUrl);
  });

  it.each([
    ['mysql://u:p@tianyi.wiki:8306/poker_scorekeeper', 'PRODUCTION_DATABASE_HOST_INVALID'],
    ['mysql://u:p@192.168.10.248:3306/poker_scorekeeper_test', 'PRODUCTION_DATABASE_NAME_INVALID'],
    ['mysql://u:p@192.168.10.248:3306/poker_scorekeeper', null]
  ])('validates %s', (databaseUrl, expectedCode) => {
    // Break caught: a production command can target a remote test endpoint or the wrong schema.
    if (expectedCode) expect(() => assertProductionTarget(databaseUrl)).toThrow(expectedCode);
    else expect(() => assertProductionTarget(databaseUrl)).not.toThrow();
  });

  it.each([
    'not a URL',
    'https://u:p@192.168.10.248:3306/poker_scorekeeper',
    'mysql://u:p@192.168.10.248/poker_scorekeeper'
  ])('rejects malformed or non-MySQL target %s without reflecting it', (databaseUrl) => {
    // Break caught: an alternate protocol or implicit port bypasses the exact production boundary.
    expect(() => assertProductionTarget(databaseUrl)).toThrow(/^PRODUCTION_DATABASE_/);
  });

  it('rejects create-database validation for every non-production target regardless of NODE_ENV', () => {
    // Break caught: omitting NODE_ENV bypasses the fixed target guard before CREATE DATABASE.
    const script = resolve(import.meta.dirname, 'create-database.mjs');
    const result = spawnSync(process.execPath, [script, '--validate-only'], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: 'mysql://u:p@127.0.0.1:3306/poker_scorekeeper_test'
      },
      encoding: 'utf8'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PRODUCTION_DATABASE_HOST_INVALID');
    expect(result.stderr).not.toContain('mysql://');
  });

  it('requires backup variables to use the same fixed production target', () => {
    const environment = {
      DATABASE_URL: productionUrl,
      MYSQL_HOST: '192.168.10.248', MYSQL_PORT: '3306', MYSQL_DATABASE: 'poker_scorekeeper',
      MYSQL_USER: 'dedicated_backup_user', MYSQL_PASSWORD: 'never-print-me'
    };
    expect(() => assertProductionBackupTarget(environment)).not.toThrow();
    expect(() => assertProductionBackupTarget({
      ...environment,
      MYSQL_DATABASE: 'poker_scorekeeper_test'
    })).toThrow('PRODUCTION_BACKUP_TARGET_INVALID');
    expect(() => assertProductionBackupTarget({
      ...environment,
      MYSQL_PASSWORD: ''
    })).toThrow('PRODUCTION_BACKUP_CREDENTIALS_MISSING');
  });
});

describe('read-only production preflight', () => {
  it('reports server, charset, existing database access, and never sends a mutating statement', async () => {
    // Break caught: preflight changes production state or exposes the connection URL while probing it.
    const fake = fakeConnector({
      databaseExists: true,
      grants: [
        "GRANT USAGE ON *.* TO `preflight_user`@`%`",
        "GRANT ALL PRIVILEGES ON `poker_scorekeeper`.* TO `preflight_user`@`%`"
      ]
    });

    const report = await runProductionPreflight(productionUrl, fake.connect);

    expect(report).toEqual({
      serverVersion: '11.4.5-MariaDB',
      currentDatabase: 'poker_scorekeeper',
      utf8mb4Available: true,
      databaseExists: true,
      canCreateDatabase: true,
      canUseDatabase: true
    });
    expect(fake.connectionOptions).toEqual([{
      host: '192.168.10.248',
      port: 3306,
      user: 'preflight_user',
      password: 'never-print-me',
      connectTimeout: 5_000,
      socketTimeout: 5_000
    }]);
    expect(fake.queries).not.toEqual([]);
    expect(fake.queries.join('\n')).not.toMatch(/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|REPLACE)\b/i);
    expect(JSON.stringify(report)).not.toContain('never-print-me');
    expect(JSON.stringify(report)).not.toContain('mysql://');
    expect(fake.ended).toBe(true);
  });

  it('reports an absent database when the account can create the exact target', async () => {
    // Break caught: initial bootstrap requires selecting a database before it exists.
    const fake = fakeConnector({
      databaseExists: false,
      grants: ["GRANT CREATE ON *.* TO `preflight_user`@`%`"]
    });

    await expect(runProductionPreflight(productionUrl, fake.connect)).resolves.toMatchObject({
      currentDatabase: null,
      databaseExists: false,
      canCreateDatabase: true,
      canUseDatabase: false
    });
    expect(fake.queries).not.toContain('USE `poker_scorekeeper`');
    expect(fake.ended).toBe(true);
  });

  it('fails with a controlled code when the existing database cannot be selected', async () => {
    // Break caught: permission failure leaks a driver message containing credentials.
    const fake = fakeConnector({
      databaseExists: true,
      grants: ["GRANT USAGE ON *.* TO `preflight_user`@`%`"],
      useDenied: true
    });

    await expect(runProductionPreflight(productionUrl, fake.connect))
      .rejects.toThrow('PRODUCTION_DATABASE_USE_DENIED');
    expect(fake.ended).toBe(true);
  });
});

describe('read-only migration evidence', () => {
  it('returns only completed, non-rolled-back migration names and checksums', async () => {
    const queries: string[] = [];
    let ended = false;
    const result = await readProductionMigrationEvidence(productionUrl, async () => ({
      query: async (sql: string) => {
        queries.push(sql);
        return [{
          migration_name: '20260817000100_initial',
          checksum: 'a'.repeat(64),
          finished_at: new Date(responseTime),
          rolled_back_at: null
        }];
      },
      end: async () => { ended = true; }
    }));

    expect(result).toEqual({
      migrations: [{ name: '20260817000100_initial', checksum: 'a'.repeat(64) }]
    });
    expect(queries).toEqual([
      'SELECT migration_name, checksum, finished_at, rolled_back_at FROM `_prisma_migrations` ORDER BY migration_name ASC'
    ]);
    expect(queries[0]).not.toMatch(/INSERT|UPDATE|DELETE|CREATE|ALTER|DROP/i);
    expect(ended).toBe(true);
  });
});

describe('production acceptance safety', () => {
  it.each([
    ['http://poker.example.com', 'PUBLIC_ORIGIN_NOT_HTTPS'],
    ['https://user:password@poker.example.com', 'PUBLIC_ORIGIN_INVALID'],
    ['https://poker.example.com/a-path', 'PUBLIC_ORIGIN_INVALID']
  ])('rejects unsafe public origin %s without reflecting it', (origin, code) => {
    // Break caught: credentials or a non-TLS endpoint can receive production session material.
    expect(() => assertPublicOrigin(origin)).toThrow(code);
  });

  it('runs the reversible HTTPS acceptance flow and returns only secret-free status evidence', async () => {
    // Break caught: acceptance skips a required stage, sends writes without CSRF, or leaves fixtures active.
    const requests: Array<{
      path: string;
      method: string;
      headers: Record<string, string>;
      body: Record<string, unknown> | undefined;
    }> = [];
    const fetchImpl = async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? 'GET';
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const body = typeof init.body === 'string'
        ? JSON.parse(init.body) as Record<string, unknown>
        : undefined;
      requests.push({ path: url.pathname, method, headers, body });

      if (url.pathname === '/api/health/ready') {
        return new Response('{}', {
          status: 200,
          headers: { 'strict-transport-security': 'max-age=31536000' }
        });
      }
      if (url.pathname === '/api/auth/login') {
        return new Response(JSON.stringify(authResponse('rootadmin', true)), {
          status: 201,
          headers: { 'set-cookie': 'poker_session=opaque-cookie; Path=/; Secure; HttpOnly' }
        });
      }
      if (url.pathname === '/api/auth/change-password') {
        return new Response(JSON.stringify(authResponse('rootadmin', false)), { status: 200 });
      }
      if (url.pathname === '/api/users' && method === 'POST') {
        return new Response(JSON.stringify(userResponse('temporary-user-id')), {
          status: 201, headers: { Location: '/api/users/temporary-user-id' }
        });
      }
      if (url.pathname === '/api/users' && method === 'GET') {
        return new Response(JSON.stringify({ users: [userResponse('temporary-user-id', undefined, undefined, true)] }), { status: 200 });
      }
      if (url.pathname === '/api/games' && method === 'POST') {
        return new Response(JSON.stringify(gameResponse('acceptance-game-id', 'DRAFT')), {
          status: 201, headers: { Location: '/api/games/acceptance-game-id' }
        });
      }
      if (url.pathname === '/api/games/acceptance-game-id/start') {
        return new Response(JSON.stringify(gameResponse('acceptance-game-id', 'ACTIVE')), { status: 200 });
      }
      if (url.pathname === '/api/games/acceptance-game-id/void') {
        return new Response(JSON.stringify(gameResponse('acceptance-game-id', 'VOIDED')), {
          status: 200
        });
      }
      if (url.pathname === '/api/users/temporary-user-id' && method === 'DELETE') {
        return new Response(JSON.stringify(userResponse('temporary-user-id', undefined, undefined, true)), {
          status: 200
        });
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    };
    const spectatorCalls: Array<Record<string, unknown>> = [];

    const report = await runProductionAcceptance({
      PUBLIC_ORIGIN: 'https://poker.example.com',
      BOOTSTRAP_ADMIN_USERNAME: 'rootadmin',
      BOOTSTRAP_ADMIN_PASSWORD: 'initial-secret-value',
      PRODUCTION_ADMIN_NEW_PASSWORD: 'rotated-secret-value'
    }, {
      fetchImpl,
      verifySpectator: async (origin, cookie, gameId) => {
        spectatorCalls.push({ origin: origin.origin, cookie, gameId });
      },
      randomId: () => 'abc123def456',
      randomSecret: () => 'temporary-secret-value',
      now: () => new Date('2026-08-19T09:30:00.000Z')
    });

    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /api/health/ready',
      'POST /api/auth/login',
      'POST /api/auth/change-password',
      'POST /api/users',
      'POST /api/games',
      'POST /api/games/acceptance-game-id/start',
      'POST /api/games/acceptance-game-id/void',
      'DELETE /api/users/temporary-user-id',
      'GET /api/users'
    ]);
    for (const request of requests.filter(
      ({ method, path }) => method !== 'GET' && path !== '/api/auth/login'
    )) {
      expect(request.headers['x-csrf-token']).toBe('a'.repeat(64));
      expect(request.headers.cookie).toBe('poker_session=opaque-cookie');
    }
    expect(requests[2]?.body).toEqual({
      currentPassword: 'initial-secret-value',
      newPassword: 'rotated-secret-value'
    });
    expect(requests[3]?.body).toMatchObject({
      username: 'accept-abc123def456',
      nickname: '验收-abc123def456',
      initialPassword: 'temporary-secret-value',
      role: 'USER'
    });
    expect(spectatorCalls).toEqual([{
      origin: 'https://poker.example.com',
      cookie: 'poker_session=opaque-cookie',
      gameId: 'acceptance-game-id'
    }]);
    expect(report).toEqual({
      acceptanceResult: 'PASS',
      healthResult: 'PASS',
      loginResult: 'PASS',
      csrfResult: 'PASS',
      passwordChangeResult: 'PASS',
      userCreationResult: 'PASS',
      gameStartResult: 'PASS',
      websocketPresenceResult: 'PASS',
      gameVoidResult: 'PASS',
      userLogicalDeleteResult: 'PASS',
      acceptanceTimestamp: '2026-08-19T09:30:00.000Z'
    });
    const serialized = JSON.stringify(report);
    for (const forbidden of [
      'poker.example.com', 'rootadmin', 'initial-secret-value', 'rotated-secret-value',
      'temporary-secret-value', 'opaque-cookie', 'temporary-user-id', 'acceptance-game-id'
    ]) expect(serialized).not.toContain(forbidden);
  });

  it('voids the owned empty game and logically deletes the owned user when WSS verification fails', async () => {
    // Break caught: a mid-acceptance failure leaves a production game or account active.
    const requested: string[] = [];
    const fetchImpl = async (input: URL | string, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname;
      const method = init.method ?? 'GET';
      requested.push(`${method} ${path}`);
      if (path === '/api/health/ready') {
        return new Response('{}', { status: 200, headers: { 'strict-transport-security': 'yes' } });
      }
      if (path === '/api/auth/login') {
        return new Response(JSON.stringify(authResponse('rootadmin', true, 'b'.repeat(64))), {
          status: 201, headers: { 'set-cookie': 'poker_session=opaque; Secure' }
        });
      }
      if (path === '/api/auth/change-password') {
        return new Response(JSON.stringify(authResponse('rootadmin', false, 'b'.repeat(64))), { status: 200 });
      }
      if (path === '/api/users' && method === 'POST') {
        return new Response(JSON.stringify(userResponse('owned-user')), {
          status: 201, headers: { Location: '/api/users/owned-user' }
        });
      }
      if (path === '/api/users' && method === 'GET') {
        return new Response(JSON.stringify({ users: [userResponse('owned-user', undefined, undefined, true)] }), { status: 200 });
      }
      if (path === '/api/games' && method === 'POST') {
        return new Response(JSON.stringify(gameResponse('owned-game', 'DRAFT')), {
          status: 201, headers: { Location: '/api/games/owned-game' }
        });
      }
      if (path === '/api/games/owned-game/start') {
        return new Response(JSON.stringify(gameResponse('owned-game', 'ACTIVE')), { status: 200 });
      }
      if (path === '/api/games/owned-game/void') {
        return new Response(JSON.stringify(gameResponse('owned-game', 'VOIDED')), { status: 200 });
      }
      if (path === '/api/users/owned-user' && method === 'DELETE') {
        return new Response(JSON.stringify(userResponse('owned-user', undefined, undefined, true)), { status: 200 });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    };

    await expect(runProductionAcceptance({
      PUBLIC_ORIGIN: 'https://poker.example.com',
      BOOTSTRAP_ADMIN_USERNAME: 'rootadmin',
      BOOTSTRAP_ADMIN_PASSWORD: 'initial-secret-value',
      PRODUCTION_ADMIN_NEW_PASSWORD: 'rotated-secret-value'
    }, {
      fetchImpl,
      verifySpectator: async () => { throw new Error('socket leaked a sensitive diagnostic'); },
      randomId: () => 'abc123def456',
      randomSecret: () => 'temporary-secret-value',
      now: () => new Date('2026-08-19T09:30:00.000Z')
    })).rejects.toThrow('PUBLIC_WSS_FAILED');
    expect(requested.slice(-2)).toEqual([
      'DELETE /api/users/owned-user',
      'GET /api/users'
    ]);
    expect(requested).toContain('POST /api/games/owned-game/void');
  });

  it('reports the primary error and every failed cleanup with owned IDs and states', async () => {
    // Break caught: the primary WSS error hides one or both failed cleanups and their manual targets.
    const fetchImpl = async (input: URL | string, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname;
      const method = init.method ?? 'GET';
      if (path === '/api/health/ready') {
        return new Response('{}', { status: 200, headers: { 'strict-transport-security': 'yes' } });
      }
      if (path === '/api/auth/login') {
        return new Response(JSON.stringify(authResponse('rootadmin', true)), {
          status: 201, headers: { 'set-cookie': 'poker_session=opaque; Secure' }
        });
      }
      if (path === '/api/auth/change-password') {
        return new Response(JSON.stringify(authResponse('rootadmin', false)), { status: 200 });
      }
      if (path === '/api/users' && method === 'POST') {
        return new Response(JSON.stringify(userResponse('owned-user')), {
          status: 201, headers: { Location: '/api/users/owned-user' }
        });
      }
      if (path === '/api/games' && method === 'POST') {
        return new Response(JSON.stringify(gameResponse('owned-game', 'DRAFT')), {
          status: 201, headers: { Location: '/api/games/owned-game' }
        });
      }
      if (path === '/api/games/owned-game/start') {
        return new Response(JSON.stringify(gameResponse('owned-game', 'ACTIVE')), { status: 200 });
      }
      if (path === '/api/games/owned-game/void') return new Response('{}', { status: 500 });
      if (path === '/api/users/owned-user' && method === 'DELETE') {
        return new Response('{}', { status: 500 });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    };

    let caught: unknown;
    try {
      await runProductionAcceptance({
        PUBLIC_ORIGIN: 'https://poker.example.com',
        BOOTSTRAP_ADMIN_USERNAME: 'rootadmin',
        BOOTSTRAP_ADMIN_PASSWORD: 'initial-secret-value',
        PRODUCTION_ADMIN_NEW_PASSWORD: 'rotated-secret-value'
      }, {
        fetchImpl,
        verifySpectator: async () => { throw new Error('private WSS diagnostic'); },
        randomId: () => 'abc123def456',
        randomSecret: () => 'temporary-secret-value'
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      message: 'PRODUCTION_ACCEPTANCE_AND_CLEANUP_FAILED',
      publicDetails: {
        manualCleanupRequired: true,
        acceptanceRunId: 'abc123def456',
        primaryError: 'PUBLIC_WSS_FAILED',
        cleanupErrors: [
          'PRODUCTION_CLEANUP_GAME_VOID_FAILED_500',
          'PRODUCTION_CLEANUP_USER_DELETE_FAILED_500'
        ],
        ownedResources: {
          user: { id: 'owned-user', state: 'ACTIVE' },
          game: { id: 'owned-game', state: 'ACTIVE' }
        }
      }
    });
    expect(JSON.stringify(caught)).not.toMatch(
      /poker\.example\.com|initial-secret-value|rotated-secret-value|temporary-secret-value|opaque/
    );
  });

  it('does not commit cleanup void state until the strict owned response passes', async () => {
    // Break caught: a schema-valid but foreign HTTP 200 response marked the owned game VOIDED.
    const fetchImpl = async (input: URL | string, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname;
      const method = init.method ?? 'GET';
      if (path === '/api/health/ready') {
        return new Response('{}', { status: 200, headers: { 'strict-transport-security': 'yes' } });
      }
      if (path === '/api/auth/login') {
        return new Response(JSON.stringify(authResponse('rootadmin', true)), {
          status: 201, headers: { 'set-cookie': 'poker_session=opaque; Secure' }
        });
      }
      if (path === '/api/auth/change-password') {
        return new Response(JSON.stringify(authResponse('rootadmin', false)), { status: 200 });
      }
      if (path === '/api/users' && method === 'POST') {
        return new Response(JSON.stringify(userResponse('owned-user')), {
          status: 201, headers: { Location: '/api/users/owned-user' }
        });
      }
      if (path === '/api/users' && method === 'GET') {
        return new Response(JSON.stringify({
          users: [userResponse('owned-user', undefined, undefined, true)]
        }), { status: 200 });
      }
      if (path === '/api/games' && method === 'POST') {
        return new Response(JSON.stringify(gameResponse('owned-game', 'DRAFT')), {
          status: 201, headers: { Location: '/api/games/owned-game' }
        });
      }
      if (path === '/api/games/owned-game/start') {
        return new Response(JSON.stringify(gameResponse('owned-game', 'ACTIVE')), { status: 200 });
      }
      if (path === '/api/games/owned-game/void') {
        return new Response(JSON.stringify({
          ...gameResponse('owned-game', 'VOIDED'),
          name: 'foreign-game'
        }), { status: 200 });
      }
      if (path === '/api/users/owned-user' && method === 'DELETE') {
        return new Response(JSON.stringify(userResponse('owned-user', undefined, undefined, true)), {
          status: 200
        });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    };

    let caught: unknown;
    try {
      await runProductionAcceptance({
        PUBLIC_ORIGIN: 'https://poker.example.com',
        BOOTSTRAP_ADMIN_USERNAME: 'rootadmin',
        BOOTSTRAP_ADMIN_PASSWORD: 'initial-secret-value',
        PRODUCTION_ADMIN_NEW_PASSWORD: 'rotated-secret-value'
      }, {
        fetchImpl,
        verifySpectator: async () => { throw new Error('private WSS diagnostic'); },
        randomId: () => 'abc123def456',
        randomSecret: () => 'temporary-secret-value'
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      message: 'PRODUCTION_ACCEPTANCE_AND_CLEANUP_FAILED',
      publicDetails: {
        cleanupErrors: ['PRODUCTION_CLEANUP_GAME_VOID_FAILED_RESPONSE_INVALID'],
        ownedResources: {
          user: { id: 'owned-user', state: 'DELETED' },
          game: { id: 'owned-game', state: 'VOID_RESPONSE_RECEIVED' }
        }
      }
    });
  });

  it('keeps a user on the manual list until delete response and readback are both strict', async () => {
    // Break caught: HTTP 200 alone marks logical deletion committed despite a malformed response.
    const fetchImpl = async (input: URL | string, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname;
      const method = init.method ?? 'GET';
      if (path === '/api/health/ready') {
        return new Response('{}', { status: 200, headers: { 'strict-transport-security': 'yes' } });
      }
      if (path === '/api/auth/login') {
        return new Response(JSON.stringify(authResponse('rootadmin', true)), {
          status: 201, headers: { 'set-cookie': 'poker_session=opaque; Secure' }
        });
      }
      if (path === '/api/auth/change-password') {
        return new Response(JSON.stringify(authResponse('rootadmin', false)), { status: 200 });
      }
      if (path === '/api/users' && method === 'POST') {
        return new Response(JSON.stringify(userResponse('owned-user')), {
          status: 201, headers: { Location: '/api/users/owned-user' }
        });
      }
      if (path === '/api/games' && method === 'POST') {
        return new Response(JSON.stringify(gameResponse('owned-game', 'DRAFT')), {
          status: 201, headers: { Location: '/api/games/owned-game' }
        });
      }
      if (path === '/api/games/owned-game/start') {
        return new Response(JSON.stringify(gameResponse('owned-game', 'ACTIVE')), { status: 200 });
      }
      if (path === '/api/games/owned-game/void') {
        return new Response(JSON.stringify(gameResponse('owned-game', 'VOIDED')), { status: 200 });
      }
      if (path === '/api/users/owned-user' && method === 'DELETE') {
        return new Response('{}', { status: 200 });
      }
      if (path === '/api/users' && method === 'GET') {
        return new Response(JSON.stringify({
          users: [userResponse('owned-user', undefined, undefined, true)]
        }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    };

    let caught: unknown;
    try {
      await runProductionAcceptance({
        PUBLIC_ORIGIN: 'https://poker.example.com',
        BOOTSTRAP_ADMIN_USERNAME: 'rootadmin',
        BOOTSTRAP_ADMIN_PASSWORD: 'initial-secret-value',
        PRODUCTION_ADMIN_NEW_PASSWORD: 'rotated-secret-value'
      }, {
        fetchImpl,
        verifySpectator: async () => undefined,
        randomId: () => 'abc123def456',
        randomSecret: () => 'temporary-secret-value'
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      message: 'PRODUCTION_USER_DELETE_FAILED_RESPONSE_INVALID',
      publicDetails: {
        manualCleanupRequired: true,
        acceptanceRunId: 'abc123def456',
        primaryError: 'PRODUCTION_USER_DELETE_FAILED_RESPONSE_INVALID',
        cleanupErrors: [],
        ownedResources: {
          user: { id: 'owned-user', state: 'DELETE_RESPONSE_RECEIVED' },
          game: { id: 'owned-game', state: 'VOIDED' }
        }
      }
    });
  });

  it('treats a successful start response as committed before validating its body', async () => {
    // Break caught: a malformed 200 response makes cleanup delete a draft after the server made it ACTIVE.
    const requested: string[] = [];
    const fetchImpl = async (input: URL | string, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname;
      const method = init.method ?? 'GET';
      requested.push(`${method} ${path}`);
      if (path === '/api/health/ready') {
        return new Response('{}', { status: 200, headers: { 'strict-transport-security': 'yes' } });
      }
      if (path === '/api/auth/login') {
        return new Response(JSON.stringify(authResponse('rootadmin', true, 'c'.repeat(64))), {
          status: 201, headers: { 'set-cookie': 'poker_session=opaque; Secure' }
        });
      }
      if (path === '/api/auth/change-password') {
        return new Response(JSON.stringify(authResponse('rootadmin', false, 'c'.repeat(64))), { status: 200 });
      }
      if (path === '/api/users' && method === 'POST') {
        return new Response(JSON.stringify(userResponse('owned-user')), {
          status: 201, headers: { Location: '/api/users/owned-user' }
        });
      }
      if (path === '/api/users' && method === 'GET') {
        return new Response(JSON.stringify({ users: [userResponse('owned-user', undefined, undefined, true)] }), { status: 200 });
      }
      if (path === '/api/games' && method === 'POST') {
        return new Response(JSON.stringify(gameResponse('owned-game', 'DRAFT')), {
          status: 201, headers: { Location: '/api/games/owned-game' }
        });
      }
      if (path === '/api/games/owned-game/start') {
        return new Response(JSON.stringify(gameResponse('owned-game', 'BROKEN')), { status: 200 });
      }
      if (path === '/api/games/owned-game/void') {
        return new Response(JSON.stringify(gameResponse('owned-game', 'VOIDED')), { status: 200 });
      }
      if (path === '/api/users/owned-user' && method === 'DELETE') {
        return new Response(JSON.stringify(userResponse('owned-user', undefined, undefined, true)), { status: 200 });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    };

    await expect(runProductionAcceptance({
      PUBLIC_ORIGIN: 'https://poker.example.com',
      BOOTSTRAP_ADMIN_USERNAME: 'rootadmin',
      BOOTSTRAP_ADMIN_PASSWORD: 'initial-secret-value',
      PRODUCTION_ADMIN_NEW_PASSWORD: 'rotated-secret-value'
    }, {
      fetchImpl,
      randomId: () => 'abc123def456',
      randomSecret: () => 'temporary-secret-value'
    })).rejects.toThrow('PRODUCTION_GAME_START_RESPONSE_INVALID');
    expect(requested.slice(-2)).toEqual([
      'DELETE /api/users/owned-user',
      'GET /api/users'
    ]);
    expect(requested).toContain('POST /api/games/owned-game/void');
    expect(requested).not.toContain('DELETE /api/games/owned-game/draft');
  });

  it('uses Location ownership to clean an exact user after a truncated 201 body', async () => {
    // Break caught: the server commits a user but response JSON truncation loses the only cleanup ID.
    const requested: string[] = [];
    const fetchImpl = async (input: URL | string, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname;
      const method = init.method ?? 'GET';
      requested.push(`${method} ${path}`);
      if (path === '/api/health/ready') {
        return new Response('{}', { status: 200, headers: { 'strict-transport-security': 'yes' } });
      }
      if (path === '/api/auth/login') {
        return new Response(JSON.stringify(authResponse('rootadmin', true)), {
          status: 201, headers: { 'set-cookie': 'poker_session=opaque; Secure' }
        });
      }
      if (path === '/api/auth/change-password') {
        return new Response(JSON.stringify(authResponse('rootadmin', false)), { status: 200 });
      }
      if (path === '/api/users' && method === 'POST') {
        return new Response('{"truncated":', {
          status: 201, headers: { Location: '/api/users/owned-user' }
        });
      }
      if (path === '/api/users/owned-user' && method === 'DELETE') {
        return new Response(JSON.stringify(userResponse('owned-user', undefined, undefined, true)), { status: 200 });
      }
      if (path === '/api/users' && method === 'GET') {
        return new Response(JSON.stringify({ users: [userResponse('owned-user', undefined, undefined, true)] }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    };

    await expect(runProductionAcceptance({
      PUBLIC_ORIGIN: 'https://poker.example.com',
      BOOTSTRAP_ADMIN_USERNAME: 'rootadmin',
      BOOTSTRAP_ADMIN_PASSWORD: 'initial-secret-value',
      PRODUCTION_ADMIN_NEW_PASSWORD: 'rotated-secret-value'
    }, {
      fetchImpl,
      randomId: () => 'abc123def456',
      randomSecret: () => 'temporary-secret-value'
    })).rejects.toThrow('PRODUCTION_USER_CREATE_RESPONSE_INVALID');
    expect(requested.slice(-2)).toEqual([
      'DELETE /api/users/owned-user',
      'GET /api/users'
    ]);
  });

  it('uses Location ownership to delete an exact draft after a truncated game 201 body', async () => {
    // Break caught: a committed game becomes unlocatable when its JSON body is truncated.
    const requested: string[] = [];
    const fetchImpl = async (input: URL | string, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname;
      const method = init.method ?? 'GET';
      requested.push(`${method} ${path}`);
      if (path === '/api/health/ready') {
        return new Response('{}', { status: 200, headers: { 'strict-transport-security': 'yes' } });
      }
      if (path === '/api/auth/login') {
        return new Response(JSON.stringify(authResponse('rootadmin', true)), {
          status: 201, headers: { 'set-cookie': 'poker_session=opaque; Secure' }
        });
      }
      if (path === '/api/auth/change-password') {
        return new Response(JSON.stringify(authResponse('rootadmin', false)), { status: 200 });
      }
      if (path === '/api/users' && method === 'POST') {
        return new Response(JSON.stringify(userResponse('owned-user')), {
          status: 201, headers: { Location: '/api/users/owned-user' }
        });
      }
      if (path === '/api/games' && method === 'POST') {
        return new Response('{"truncated":', {
          status: 201, headers: { Location: '/api/games/owned-game' }
        });
      }
      if (path === '/api/games/owned-game/draft' && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (path === '/api/users/owned-user' && method === 'DELETE') {
        return new Response(JSON.stringify(userResponse('owned-user', undefined, undefined, true)), { status: 200 });
      }
      if (path === '/api/users' && method === 'GET') {
        return new Response(JSON.stringify({ users: [userResponse('owned-user', undefined, undefined, true)] }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    };

    await expect(runProductionAcceptance({
      PUBLIC_ORIGIN: 'https://poker.example.com',
      BOOTSTRAP_ADMIN_USERNAME: 'rootadmin',
      BOOTSTRAP_ADMIN_PASSWORD: 'initial-secret-value',
      PRODUCTION_ADMIN_NEW_PASSWORD: 'rotated-secret-value'
    }, {
      fetchImpl,
      randomId: () => 'abc123def456',
      randomSecret: () => 'temporary-secret-value'
    })).rejects.toThrow('PRODUCTION_GAME_CREATE_RESPONSE_INVALID');
    expect(requested.slice(-3)).toEqual([
      'DELETE /api/games/owned-game/draft',
      'DELETE /api/users/owned-user',
      'GET /api/users'
    ]);
  });

  it('stops without deleting when a successful create has no provable owner and records manual cleanup', async () => {
    // Break caught: an unowned 201 response leads cleanup to guess an ID and delete an unrelated object.
    const requested: string[] = [];
    const fetchImpl = async (input: URL | string, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname;
      const method = init.method ?? 'GET';
      requested.push(`${method} ${path}`);
      if (path === '/api/health/ready') {
        return new Response('{}', { status: 200, headers: { 'strict-transport-security': 'yes' } });
      }
      if (path === '/api/auth/login') {
        return new Response(JSON.stringify(authResponse('rootadmin', true)), {
          status: 201, headers: { 'set-cookie': 'poker_session=opaque; Secure' }
        });
      }
      if (path === '/api/auth/change-password') {
        return new Response(JSON.stringify(authResponse('rootadmin', false)), { status: 200 });
      }
      if (path === '/api/users' && method === 'POST') {
        return new Response(JSON.stringify(userResponse('unknown-user')), { status: 201 });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    };

    let caught: unknown;
    try {
      await runProductionAcceptance({
        PUBLIC_ORIGIN: 'https://poker.example.com',
        BOOTSTRAP_ADMIN_USERNAME: 'rootadmin',
        BOOTSTRAP_ADMIN_PASSWORD: 'initial-secret-value',
        PRODUCTION_ADMIN_NEW_PASSWORD: 'rotated-secret-value'
      }, {
        fetchImpl,
        randomId: () => 'abc123def456',
        randomSecret: () => 'temporary-secret-value'
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      message: 'PRODUCTION_USER_OWNERSHIP_UNCONFIRMED',
      publicDetails: {
        manualCleanupRequired: true,
        acceptanceRunId: 'abc123def456',
        resources: ['TEMPORARY_USER']
      }
    });
    expect(requested).toEqual([
      'GET /api/health/ready',
      'POST /api/auth/login',
      'POST /api/auth/change-password',
      'POST /api/users'
    ]);
  });

  it('uses only a WebSocket transport and requires an acknowledged spectator join', async () => {
    // Break caught: the acceptance check silently falls back to HTTP polling or never joins the room.
    const listeners = new Map<string, (value?: unknown) => void>();
    const calls: Array<{ origin: string; options: Record<string, unknown> }> = [];
    const emitted: Array<{ event: string; payload: unknown }> = [];
    let disconnected = false;
    const createSocket = (origin: string, options: Record<string, unknown>) => {
      calls.push({ origin, options });
      return {
        io: { engine: { transport: { name: 'websocket' } } },
        once(event: string, listener: (value?: unknown) => void) { listeners.set(event, listener); },
        off(event: string) { listeners.delete(event); },
        connect() { listeners.get('connect')?.(); },
        emit(event: string, payload: unknown, acknowledge: (value: unknown) => void) {
          emitted.push({ event, payload });
          if (event === 'game.join') {
            acknowledge({ ok: true, gameId: 'game-id', version: 2, snapshotSent: true });
            return;
          }
          acknowledge({ ok: true, gameId: 'game-id' });
        },
        disconnect() { disconnected = true; }
      };
    };

    await expect(joinProductionSpectator(
      new URL('https://poker.example.com'),
      'poker_session=opaque',
      'game-id',
      createSocket
    )).resolves.toBeUndefined();
    expect(calls).toEqual([{
      origin: 'https://poker.example.com',
      options: {
        autoConnect: false,
        transports: ['websocket'],
        reconnection: false,
        timeout: 10_000,
        extraHeaders: {
          Cookie: 'poker_session=opaque',
          Origin: 'https://poker.example.com'
        }
      }
    }]);
    expect(emitted).toEqual([
      { event: 'game.join', payload: { gameId: 'game-id', knownVersion: 0 } },
      { event: 'game.leave', payload: { gameId: 'game-id' } }
    ]);
    expect(disconnected).toBe(true);
  });

  it('rejects a partial WSS acknowledgement through the shared join contract', async () => {
    // Break caught: the acceptance script accepts an acknowledgement without version/snapshotSent.
    const listeners = new Map<string, () => void>();
    const createSocket = () => ({
      io: { engine: { transport: { name: 'websocket' } } },
      once(event: string, listener: () => void) { listeners.set(event, listener); },
      off(event: string) { listeners.delete(event); },
      connect() { listeners.get('connect')?.(); },
      emit(_event: string, _payload: unknown, acknowledge: (value: unknown) => void) {
        acknowledge({ ok: true, gameId: 'game-id' });
      },
      disconnect() {}
    });

    await expect(joinProductionSpectator(
      new URL('https://poker.example.com'),
      'poker_session=opaque',
      'game-id',
      createSocket
    )).rejects.toThrow('PUBLIC_WSS_JOIN_FAILED');
  });

  it('waits for a strict acknowledged leave before disconnecting the spectator', async () => {
    // Break caught: disconnect raced with void because acceptance never waited for presence removal.
    const listeners = new Map<string, () => void>();
    const createSocket = () => ({
      io: { engine: { transport: { name: 'websocket' } } },
      once(event: string, listener: () => void) { listeners.set(event, listener); },
      off(event: string) { listeners.delete(event); },
      connect() { listeners.get('connect')?.(); },
      emit(event: string, _payload: unknown, acknowledge: (value: unknown) => void) {
        if (event === 'game.join') {
          acknowledge({ ok: true, gameId: 'game-id', version: 2, snapshotSent: true });
          return;
        }
        acknowledge({ ok: true, gameId: 'game-id', extra: true });
      },
      disconnect() {}
    });

    await expect(joinProductionSpectator(
      new URL('https://poker.example.com'),
      'poker_session=opaque',
      'game-id',
      createSocket
    )).rejects.toThrow('PUBLIC_WSS_LEAVE_FAILED');
  });
});

describe('secret-free production verification record', () => {
  it('formats only validated digest, migration, health, backup, and acceptance evidence', () => {
    // Break caught: the durable record accepts a URL, password, cookie, or uncontrolled free text.
    const record = formatProductionVerificationRecord(verificationEvidence());

    for (const required of [
      `sha256:${'1'.repeat(64)}`,
      'deploy-20260819-abc123',
      '20260818000100_settlement_settler_snapshot',
      '5'.repeat(64),
      'health | PASS',
      'backup | PASS',
      'acceptance | PASS',
      'mysql-20260819T093000Z.sql.gz',
      '2026-08-19T09:30:00.000Z'
    ]) expect(record).toContain(required);
    expect(record).not.toMatch(/https?:\/\/|mysql:\/\/|password|cookie/i);
  });

  it('rejects any non-PASS evidence instead of hard-coding acceptance success', () => {
    expect(() => formatProductionVerificationRecord({
      ...verificationEvidence(),
      acceptanceResult: 'FAIL'
    })).toThrow('PRODUCTION_RECORD_ACCEPTANCE_INVALID');
  });

  it('collects Docker, migration, health, backup, and acceptance evidence from real probes', async () => {
    // Break caught: arbitrary environment values can be shaped like PASS and written as production proof.
    const migrations = await collectRepositoryMigrationEvidence();
    const stamp = '20260819T093000Z';
    const checksums = [
      `${'2'.repeat(64)}  mysql-${stamp}.sql.gz`,
      `${'3'.repeat(64)}  avatars-${stamp}.tar.gz`,
      `${'4'.repeat(64)}  manifest-${stamp}.txt`
    ].join('\n');
    const commands: Array<{ key: string; options?: { cwd?: string; env?: NodeJS.ProcessEnv } }> = [];
    const runCommand = async (
      command: string,
      arguments_: string[],
      options?: { cwd?: string; env?: NodeJS.ProcessEnv }
    ) => {
      const key = `${command} ${arguments_.join(' ')}`;
      commands.push({ key, options });
      let stdout = '';
      if (key.includes('version --format')) stdout = '27.1.0';
      else if (key.endsWith('version --short')) stdout = '2.34.0';
      else if (key.includes('image inspect') && key.includes('{{.Id}}')) {
        stdout = `sha256:${'1'.repeat(64)}`;
      } else if (key.includes('image inspect') && key.includes('org.opencontainers.image.revision')) {
        stdout = 'deploy-20260819-abc123';
      }
      else if (key.includes('ps -q app')) stdout = 'a'.repeat(64);
      else if (key.includes(`inspect ${'a'.repeat(64)}`)) {
        stdout = `sha256:${'1'.repeat(64)} running healthy`;
      }
      else if (key.includes('prisma migrate status')) stdout = 'Database schema is up to date!';
      else if (key.includes('production-migration-evidence.mjs')) {
        stdout = JSON.stringify({ migrations });
      } else if (key.includes('latest-stamp')) stdout = stamp;
      else if (key.includes('cat /app/deployment-id')) stdout = 'deploy-20260819-abc123';
      else if (key.includes(`checksums-${stamp}.txt`) || key.includes('sha256sum mysql-')) {
        stdout = checksums;
      } else if (
        !key.includes('production-backup-target.mjs') &&
        !key.includes('scripts/backup/backup.sh')
      ) {
        throw new Error(`Unexpected command: ${key}`);
      }
      return { exitCode: 0, stdout, stderr: '' };
    };

    const composeEnvironment = Object.entries(process.env).filter(([key]) => (
      ['compose_file', 'compose_project_name'].includes(key.toLowerCase())
    ));
    for (const [key] of composeEnvironment) delete process.env[key];
    process.env.compose_file = '../attacker-compose.yml';
    process.env.CoMpOsE_PrOjEcT_NaMe = 'attacker-project';
    let evidence;
    try {
      evidence = await runProductionVerification({
        PUBLIC_ORIGIN: 'https://poker.example.com'
      }, {
        runCommand,
        acceptanceRunner: async () => acceptanceReport(),
        fetchImpl: async (input: URL | string) => {
          const path = new URL(String(input)).pathname;
          return new Response(JSON.stringify(
            path === '/api/health/deployment'
              ? { deploymentId: 'deploy-20260819-abc123' }
              : {}
          ), {
            status: 200,
            headers: { 'strict-transport-security': 'max-age=31536000' }
          });
        }
      });
    } finally {
      for (const key of Object.keys(process.env)) {
        if (['compose_file', 'compose_project_name'].includes(key.toLowerCase())) {
          delete process.env[key];
        }
      }
      for (const [key, value] of composeEnvironment) process.env[key] = value;
    }

    expect(evidence).toEqual({
      ...verificationEvidence(),
      migrationVersion: migrations.at(-1)?.name,
      migrationChecksum: migrations.at(-1)?.checksum
    });
    expect(commands.some(({ key }) => key.includes('production-migration-evidence.mjs'))).toBe(true);
    expect(commands.some(({ key }) => key.includes('scripts/backup/backup.sh'))).toBe(true);
    expect(commands.some(({ key }) => key.includes('ps -q app'))).toBe(true);
    expect(commands.some(({ key }) => key.includes(`inspect ${'a'.repeat(64)}`))).toBe(true);
    const expectedRoot = resolve(import.meta.dirname, '../..');
    for (const command of commands) {
      expect(command.options?.cwd).toBe(expectedRoot);
      expect(Object.keys(command.options?.env ?? {}).filter((key) => (
        ['compose_file', 'compose_project_name'].includes(key.toLowerCase())
      ))).toEqual([]);
      if (command.key.startsWith('docker compose ')) {
        expect(command.key).toContain(
          'docker compose --file docker-compose.yml --project-name poker-scorekeeper'
        );
      }
    }
  });

  it('rejects a public origin served by a different deployment before acceptance', async () => {
    // Break caught: a healthy unrelated origin is accepted as evidence for the inspected container.
    const migrations = await collectRepositoryMigrationEvidence();
    const acceptanceRunner = vi.fn();
    const runCommand = async (_command: string, arguments_: string[]) => {
      const key = arguments_.join(' ');
      let stdout = '';
      if (key.includes('version --format')) stdout = '27.1.0';
      else if (key.endsWith('version --short')) stdout = '2.34.0';
      else if (key.includes('image inspect') && key.includes('{{.Id}}')) stdout = `sha256:${'1'.repeat(64)}`;
      else if (key.includes('org.opencontainers.image.revision')) stdout = 'deploy-20260819-abc123';
      else if (key.includes('ps -q app')) stdout = 'a'.repeat(64);
      else if (key.startsWith(`inspect ${'a'.repeat(64)}`)) stdout = `sha256:${'1'.repeat(64)} running healthy`;
      else if (key.includes('cat /app/deployment-id')) stdout = 'deploy-20260819-abc123';
      else if (key.includes('prisma migrate status')) stdout = 'Database schema is up to date!';
      else if (key.includes('production-migration-evidence.mjs')) stdout = JSON.stringify({ migrations });
      return { exitCode: 0, stdout, stderr: '' };
    };

    await expect(runProductionVerification({ PUBLIC_ORIGIN: 'https://poker.example.com' }, {
      runCommand,
      repositoryMigrations: async () => migrations,
      acceptanceRunner,
      fetchImpl: async (input: URL | string) => new Response(JSON.stringify(
        new URL(String(input)).pathname === '/api/health/deployment'
          ? { deploymentId: 'different-deployment' }
          : {}
      ), { status: 200, headers: { 'strict-transport-security': 'yes' } })
    })).rejects.toThrow('PRODUCTION_DEPLOYMENT_MISMATCH');
    expect(acceptanceRunner).not.toHaveBeenCalled();
  });

  it('fails before acceptance when Docker cannot be inspected', async () => {
    const acceptanceRunner = vi.fn();
    await expect(runProductionVerification({ PUBLIC_ORIGIN: 'https://poker.example.com' }, {
      runCommand: async () => { throw new Error('ENOENT'); },
      acceptanceRunner
    })).rejects.toThrow('PRODUCTION_DOCKER_UNAVAILABLE');
    expect(acceptanceRunner).not.toHaveBeenCalled();
  });

  it('flushes a same-directory temporary file before atomically renaming it', async () => {
    const operations: string[] = [];
    let temporary = '';
    await writeProductionVerificationRecord(verificationEvidence(), {
      randomId: () => 'atomic-test',
      openImpl: async (target: URL, flags: string, mode: number) => {
        operations.push(`open:${flags}:${mode.toString(8)}`);
        expect(target.pathname).toMatch(/\/docs\/deployment\/production-verification\.[^/]+\.atomic-test\.tmp$/);
        return {
          writeFile: async (contents: string, encoding: string) => {
            operations.push(`write:${encoding}`);
            temporary = contents;
          },
          sync: async () => { operations.push('sync'); },
          close: async () => { operations.push('close'); }
        };
      },
      renameImpl: async (source: URL, target: URL) => {
        operations.push('rename');
        expect(source.pathname.substring(0, source.pathname.lastIndexOf('/')))
          .toBe(target.pathname.substring(0, target.pathname.lastIndexOf('/')));
        expect(target.pathname).toMatch(/\/docs\/deployment\/production-verification\.md$/);
      },
      rmImpl: async () => { operations.push('rm'); }
    });

    expect(operations).toEqual(['open:wx:600', 'write:utf8', 'sync', 'close', 'rename']);
    expect(temporary).toContain('| acceptance | PASS |');
  });

  it('does not replace the previous record when atomic publication fails', async () => {
    const durableRecord = 'previous verified record';
    let removed = false;
    await expect(writeProductionVerificationRecord(verificationEvidence(), {
      randomId: () => 'rename-failure',
      openImpl: async () => ({
        writeFile: async () => undefined,
        sync: async () => undefined,
        close: async () => undefined
      }),
      renameImpl: async () => { throw new Error('rename failed'); },
      rmImpl: async () => { removed = true; }
    })).rejects.toThrow('PRODUCTION_RECORD_WRITE_FAILED');
    expect(durableRecord).toBe('previous verified record');
    expect(removed).toBe(true);
  });
});
