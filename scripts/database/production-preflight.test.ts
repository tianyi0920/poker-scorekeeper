import { describe, expect, it } from 'vitest';
import {
  assertProductionTarget,
  runProductionPreflight
} from './production-preflight.mjs';
import {
  assertPublicOrigin,
  formatProductionVerificationRecord,
  joinProductionSpectator,
  runProductionAcceptance,
  writeProductionVerificationRecord
} from '../verify-production.mjs';

const productionUrl = 'mysql://preflight_user:never-print-me@192.168.10.248:3306/poker_scorekeeper';

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
        return new Response(JSON.stringify({
          user: { id: 'admin-id', role: 'SUPER_ADMIN', mustChangePassword: true },
          csrfToken: 'a'.repeat(64)
        }), {
          status: 201,
          headers: { 'set-cookie': 'poker_session=opaque-cookie; Path=/; Secure; HttpOnly' }
        });
      }
      if (url.pathname === '/api/auth/change-password') {
        return new Response(JSON.stringify({
          user: { id: 'admin-id', role: 'SUPER_ADMIN', mustChangePassword: false },
          csrfToken: 'a'.repeat(64)
        }), { status: 200 });
      }
      if (url.pathname === '/api/users' && method === 'POST') {
        return new Response(JSON.stringify({ id: 'temporary-user-id' }), { status: 201 });
      }
      if (url.pathname === '/api/games' && method === 'POST') {
        return new Response(JSON.stringify({
          id: 'acceptance-game-id', status: 'DRAFT', players: [], purchases: []
        }), { status: 201 });
      }
      if (url.pathname === '/api/games/acceptance-game-id/start') {
        return new Response(JSON.stringify({
          id: 'acceptance-game-id', status: 'ACTIVE', players: [], purchases: []
        }), { status: 200 });
      }
      if (url.pathname === '/api/games/acceptance-game-id/void') {
        return new Response(JSON.stringify({ id: 'acceptance-game-id', status: 'VOIDED' }), {
          status: 200
        });
      }
      if (url.pathname === '/api/users/temporary-user-id' && method === 'DELETE') {
        return new Response(JSON.stringify({ id: 'temporary-user-id', deletedAt: 'now' }), {
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
      'DELETE /api/users/temporary-user-id'
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
        return new Response(JSON.stringify({
          user: { id: 'admin-id', role: 'SUPER_ADMIN', mustChangePassword: true },
          csrfToken: 'b'.repeat(64)
        }), { status: 201, headers: { 'set-cookie': 'poker_session=opaque; Secure' } });
      }
      if (path === '/api/auth/change-password') {
        return new Response(JSON.stringify({ user: { mustChangePassword: false } }), { status: 200 });
      }
      if (path === '/api/users' && method === 'POST') {
        return new Response(JSON.stringify({ id: 'owned-user' }), { status: 201 });
      }
      if (path === '/api/games' && method === 'POST') {
        return new Response(JSON.stringify({ id: 'owned-game', status: 'DRAFT', players: [], purchases: [] }), { status: 201 });
      }
      if (path === '/api/games/owned-game/start') {
        return new Response(JSON.stringify({ id: 'owned-game', status: 'ACTIVE', players: [], purchases: [] }), { status: 200 });
      }
      if (path === '/api/games/owned-game/void') {
        return new Response(JSON.stringify({ id: 'owned-game', status: 'VOIDED' }), { status: 200 });
      }
      if (path === '/api/users/owned-user' && method === 'DELETE') {
        return new Response('{}', { status: 200 });
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
      'POST /api/games/owned-game/void',
      'DELETE /api/users/owned-user'
    ]);
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
        return new Response(JSON.stringify({
          user: { role: 'SUPER_ADMIN' }, csrfToken: 'c'.repeat(64)
        }), { status: 201, headers: { 'set-cookie': 'poker_session=opaque; Secure' } });
      }
      if (path === '/api/auth/change-password') {
        return new Response(JSON.stringify({ user: { mustChangePassword: false } }), { status: 200 });
      }
      if (path === '/api/users' && method === 'POST') {
        return new Response(JSON.stringify({ id: 'owned-user' }), { status: 201 });
      }
      if (path === '/api/games' && method === 'POST') {
        return new Response(JSON.stringify({ id: 'owned-game', status: 'DRAFT', players: [], purchases: [] }), { status: 201 });
      }
      if (path === '/api/games/owned-game/start') {
        return new Response(JSON.stringify({
          id: 'owned-game', status: 'BROKEN', players: [], purchases: []
        }), { status: 200 });
      }
      if (path === '/api/games/owned-game/void') {
        return new Response(JSON.stringify({ id: 'owned-game', status: 'VOIDED' }), { status: 200 });
      }
      if (path === '/api/users/owned-user' && method === 'DELETE') {
        return new Response('{}', { status: 200 });
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
    })).rejects.toThrow('PRODUCTION_ACCEPTANCE_GAME_NOT_EMPTY');
    expect(requested.slice(-2)).toEqual([
      'POST /api/games/owned-game/void',
      'DELETE /api/users/owned-user'
    ]);
    expect(requested).not.toContain('DELETE /api/games/owned-game/draft');
  });

  it('uses only a WebSocket transport and requires an acknowledged spectator join', async () => {
    // Break caught: the acceptance check silently falls back to HTTP polling or never joins the room.
    const listeners = new Map<string, (value?: unknown) => void>();
    const calls: Array<{ origin: string; options: Record<string, unknown> }> = [];
    let disconnected = false;
    const createSocket = (origin: string, options: Record<string, unknown>) => {
      calls.push({ origin, options });
      return {
        io: { engine: { transport: { name: 'websocket' } } },
        once(event: string, listener: (value?: unknown) => void) { listeners.set(event, listener); },
        off(event: string) { listeners.delete(event); },
        connect() { listeners.get('connect')?.(); },
        emit(event: string, payload: unknown, acknowledge: (value: unknown) => void) {
          expect(event).toBe('game.join');
          expect(payload).toEqual({ gameId: 'game-id', knownVersion: 0 });
          acknowledge({ ok: true, gameId: 'game-id', version: 2, snapshotSent: true });
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
    expect(disconnected).toBe(true);
  });
});

describe('secret-free production verification record', () => {
  it('formats only validated digest, migration, health, backup, and acceptance evidence', () => {
    // Break caught: the durable record accepts a URL, password, cookie, or uncontrolled free text.
    const stamp = '20260819T093000Z';
    const record = formatProductionVerificationRecord({
      imageDigest: `sha256:${'1'.repeat(64)}`,
      migrationVersion: '20260818000100_settlement_settler_snapshot',
      healthResult: 'PASS',
      backupResult: 'PASS',
      backupStamp: stamp,
      backupFiles: [
        { name: `mysql-${stamp}.sql.gz`, sha256: '2'.repeat(64) },
        { name: `avatars-${stamp}.tar.gz`, sha256: '3'.repeat(64) },
        { name: `manifest-${stamp}.txt`, sha256: '4'.repeat(64) }
      ],
      acceptanceTimestamp: '2026-08-19T09:30:00.000Z'
    });

    for (const required of [
      `sha256:${'1'.repeat(64)}`,
      '20260818000100_settlement_settler_snapshot',
      'health | PASS',
      'backup | PASS',
      `mysql-${stamp}.sql.gz`,
      '2026-08-19T09:30:00.000Z'
    ]) expect(record).toContain(required);
    expect(record).not.toMatch(/https?:\/\/|mysql:\/\/|password|cookie/i);
  });

  it('rejects uncontrolled evidence fields instead of copying them into the record', () => {
    const stamp = '20260819T093000Z';
    expect(() => formatProductionVerificationRecord({
      imageDigest: 'sha256:not-a-digest mysql://u:secret@host/db',
      migrationVersion: '20260818000100_settlement_settler_snapshot',
      healthResult: 'PASS',
      backupResult: 'PASS',
      backupStamp: stamp,
      backupFiles: [],
      acceptanceTimestamp: '2026-08-19T09:30:00.000Z'
    })).toThrow('PRODUCTION_RECORD_IMAGE_DIGEST_INVALID');
  });

  it('writes validated evidence only to the fixed production record path', async () => {
    // Break caught: the recorder accepts an arbitrary output path or copies unrelated environment secrets.
    const writes: Array<{ target: string; contents: string; encoding: string }> = [];
    const stamp = '20260819T093000Z';
    await writeProductionVerificationRecord({
      PRODUCTION_IMAGE_DIGEST: `sha256:${'1'.repeat(64)}`,
      PRODUCTION_MIGRATION_VERSION: '20260818000100_settlement_settler_snapshot',
      PRODUCTION_HEALTH_RESULT: 'PASS',
      PRODUCTION_BACKUP_RESULT: 'PASS',
      PRODUCTION_BACKUP_STAMP: stamp,
      PRODUCTION_BACKUP_MYSQL_SHA256: '2'.repeat(64),
      PRODUCTION_BACKUP_AVATARS_SHA256: '3'.repeat(64),
      PRODUCTION_BACKUP_MANIFEST_SHA256: '4'.repeat(64),
      PRODUCTION_ACCEPTANCE_TIMESTAMP: '2026-08-19T09:30:00.000Z',
      DATABASE_URL: 'mysql://user:must-not-be-copied@host/database',
      BOOTSTRAP_ADMIN_PASSWORD: 'must-not-be-copied'
    }, async (target, contents, encoding) => {
      writes.push({ target: String(target), contents, encoding });
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.target.replaceAll('\\', '/')).toMatch(
      /\/docs\/deployment\/production-verification\.md$/
    );
    expect(writes[0]?.encoding).toBe('utf8');
    expect(writes[0]?.contents).not.toContain('must-not-be-copied');
    expect(writes[0]?.contents).not.toContain('mysql://');
  });
});
