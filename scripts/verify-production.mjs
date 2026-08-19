/* global AbortController, URL, clearTimeout, process, setTimeout */

import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const requireFromWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { io } = requireFromWeb('socket.io-client');
const SESSION_COOKIE_NAME = 'poker_session';
const REQUEST_TIMEOUT_MS = 10_000;

function controlledError(code) {
  return new Error(code);
}

function isControlledError(error) {
  return error instanceof Error && /^(?:PUBLIC|PRODUCTION)_[A-Z0-9_]+$/.test(error.message);
}

export function assertPublicOrigin(value) {
  let origin;
  try {
    origin = new URL(value);
  } catch {
    throw controlledError('PUBLIC_ORIGIN_INVALID');
  }
  if (origin.protocol !== 'https:') throw controlledError('PUBLIC_ORIGIN_NOT_HTTPS');
  if (
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== '' ||
    origin.origin === 'null'
  ) {
    throw controlledError('PUBLIC_ORIGIN_INVALID');
  }
  return origin;
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value === '') {
    throw controlledError(`PRODUCTION_${name}_MISSING`);
  }
  return value;
}

function assertPassword(value, code) {
  if (value.length < 8 || value.length > 128) throw controlledError(code);
}

function safeIdentifier(value, code) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(value)) {
    throw controlledError(code);
  }
  return value;
}

function sessionCookie(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];
  const serialized = values.find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?? response.headers.get('set-cookie');
  const cookie = serialized?.split(';', 1)[0];
  if (cookie === undefined || !/^poker_session=[A-Za-z0-9_-]+$/.test(cookie)) {
    throw controlledError('PRODUCTION_LOGIN_COOKIE_INVALID');
  }
  return cookie;
}

async function responseJson(response, code) {
  try {
    const body = await response.json();
    if (typeof body !== 'object' || body === null) throw new Error('invalid');
    return body;
  } catch {
    throw controlledError(code);
  }
}

async function timedFetch(fetchImpl, input, init, code) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal, redirect: 'error' });
  } catch {
    throw controlledError(code);
  } finally {
    clearTimeout(timeout);
  }
}

function statusError(prefix, status) {
  const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
  return controlledError(`${prefix}_${safeStatus}`);
}

async function healthCheck(origin, fetchImpl) {
  const response = await timedFetch(
    fetchImpl,
    new URL('/api/health/ready', origin),
    { method: 'GET', headers: { Accept: 'application/json' } },
    'PUBLIC_HEALTH_FAILED_0'
  );
  if (!response.ok) throw statusError('PUBLIC_HEALTH_FAILED', response.status);
  if (!response.headers.get('strict-transport-security')) throw controlledError('HSTS_MISSING');
}

async function apiRequest(origin, fetchImpl, path, options) {
  const headers = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.auth !== undefined) {
    headers.Cookie = options.auth.cookie;
    headers['X-CSRF-Token'] = options.auth.csrfToken;
  }
  const response = await timedFetch(fetchImpl, new URL(path, origin), {
    method: options.method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  }, `${options.errorPrefix}_0`);
  if (response.status !== options.expectedStatus) {
    throw statusError(options.errorPrefix, response.status);
  }
  return responseJson(response, `${options.errorPrefix}_RESPONSE_INVALID`);
}

export async function joinProductionSpectator(
  origin,
  cookie,
  gameId,
  createSocket = io
) {
  const socket = createSocket(origin.origin, {
    autoConnect: false,
    transports: ['websocket'],
    reconnection: false,
    timeout: REQUEST_TIMEOUT_MS,
    extraHeaders: {
      Cookie: cookie,
      Origin: origin.origin
    }
  });

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('connect_error', onConnectError);
        if (error === undefined) resolve();
        else reject(error);
      };
      const timer = setTimeout(() => finish(controlledError('PUBLIC_WSS_FAILED')), REQUEST_TIMEOUT_MS);
      timer.unref?.();
      const onConnectError = () => finish(controlledError('PUBLIC_WSS_FAILED'));
      const onConnect = () => {
        if (socket.io?.engine?.transport?.name !== 'websocket') {
          finish(controlledError('PUBLIC_WSS_TRANSPORT_INVALID'));
          return;
        }
        socket.emit('game.join', { gameId, knownVersion: 0 }, (acknowledgement) => {
          if (
            typeof acknowledgement !== 'object' ||
            acknowledgement === null ||
            acknowledgement.ok !== true ||
            acknowledgement.gameId !== gameId
          ) {
            finish(controlledError('PUBLIC_WSS_JOIN_FAILED'));
            return;
          }
          finish();
        });
      };
      socket.once('connect_error', onConnectError);
      socket.once('connect', onConnect);
      try {
        socket.connect();
      } catch {
        finish(controlledError('PUBLIC_WSS_FAILED'));
      }
    });
  } finally {
    socket.disconnect();
  }
}

function acceptanceDependencies(overrides) {
  return {
    fetchImpl: overrides.fetchImpl ?? globalThis.fetch,
    verifySpectator: overrides.verifySpectator ?? joinProductionSpectator,
    randomId: overrides.randomId ?? (() => randomUUID().replaceAll('-', '').slice(0, 12)),
    randomSecret: overrides.randomSecret ?? (() => `${randomBytes(24).toString('base64url')}Aa1!`),
    now: overrides.now ?? (() => new Date())
  };
}

export async function runProductionAcceptance(environment, overrides = {}) {
  const origin = assertPublicOrigin(requiredEnvironment(environment, 'PUBLIC_ORIGIN'));
  const username = requiredEnvironment(environment, 'BOOTSTRAP_ADMIN_USERNAME');
  const currentPassword = requiredEnvironment(environment, 'BOOTSTRAP_ADMIN_PASSWORD');
  const newPassword = requiredEnvironment(environment, 'PRODUCTION_ADMIN_NEW_PASSWORD');
  assertPassword(currentPassword, 'PRODUCTION_BOOTSTRAP_PASSWORD_INVALID');
  assertPassword(newPassword, 'PRODUCTION_ADMIN_NEW_PASSWORD_INVALID');
  if (currentPassword === newPassword) {
    throw controlledError('PRODUCTION_ADMIN_PASSWORD_NOT_ROTATED');
  }
  const dependencies = acceptanceDependencies(overrides);
  const runId = dependencies.randomId();
  if (!/^[a-z0-9]{12}$/.test(runId)) throw controlledError('PRODUCTION_ACCEPTANCE_RUN_ID_INVALID');
  const temporaryPassword = dependencies.randomSecret();
  assertPassword(temporaryPassword, 'PRODUCTION_TEMPORARY_PASSWORD_INVALID');

  let auth;
  let temporaryUserId;
  let temporaryUserDeleted = false;
  let gameId;
  let gameState;
  let primaryError;
  let cleanupError;
  let report;

  try {
    await healthCheck(origin, dependencies.fetchImpl);

    const loginResponse = await timedFetch(dependencies.fetchImpl, new URL('/api/auth/login', origin), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: currentPassword })
    }, 'PRODUCTION_LOGIN_FAILED_0');
    if (loginResponse.status !== 201) throw statusError('PRODUCTION_LOGIN_FAILED', loginResponse.status);
    const login = await responseJson(loginResponse, 'PRODUCTION_LOGIN_RESPONSE_INVALID');
    if (
      login.user?.role !== 'SUPER_ADMIN' ||
      typeof login.csrfToken !== 'string' ||
      !/^[a-f0-9]{64}$/.test(login.csrfToken)
    ) {
      throw controlledError('PRODUCTION_LOGIN_RESPONSE_INVALID');
    }
    auth = { cookie: sessionCookie(loginResponse), csrfToken: login.csrfToken };

    const passwordChange = await apiRequest(origin, dependencies.fetchImpl, '/api/auth/change-password', {
      method: 'POST',
      expectedStatus: 200,
      errorPrefix: 'PRODUCTION_PASSWORD_CHANGE_FAILED',
      auth,
      body: { currentPassword, newPassword }
    });
    if (passwordChange.user?.mustChangePassword !== false) {
      throw controlledError('PRODUCTION_PASSWORD_CHANGE_RESPONSE_INVALID');
    }

    const createdUser = await apiRequest(origin, dependencies.fetchImpl, '/api/users', {
      method: 'POST',
      expectedStatus: 201,
      errorPrefix: 'PRODUCTION_USER_CREATE_FAILED',
      auth,
      body: {
        username: `accept-${runId}`,
        nickname: `验收-${runId}`,
        initialPassword: temporaryPassword,
        role: 'USER',
        rakeEnabled: false
      }
    });
    temporaryUserId = safeIdentifier(createdUser.id, 'PRODUCTION_USER_CREATE_RESPONSE_INVALID');

    const createdGame = await apiRequest(origin, dependencies.fetchImpl, '/api/games', {
      method: 'POST',
      expectedStatus: 201,
      errorPrefix: 'PRODUCTION_GAME_CREATE_FAILED',
      auth,
      body: { name: `生产验收-${runId}`, handPrice: '300', rakeEnabled: false }
    });
    gameId = safeIdentifier(createdGame.id, 'PRODUCTION_GAME_CREATE_RESPONSE_INVALID');
    gameState = 'DRAFT';
    if (
      createdGame.status !== 'DRAFT' ||
      !Array.isArray(createdGame.players) || createdGame.players.length !== 0 ||
      !Array.isArray(createdGame.purchases) || createdGame.purchases.length !== 0
    ) {
      throw controlledError('PRODUCTION_ACCEPTANCE_GAME_NOT_EMPTY');
    }

    const startedGame = await apiRequest(
      origin,
      dependencies.fetchImpl,
      `/api/games/${gameId}/start`,
      {
        method: 'POST',
        expectedStatus: 200,
        errorPrefix: 'PRODUCTION_GAME_START_FAILED',
        auth
      }
    );
    gameState = 'ACTIVE';
    if (
      startedGame.status !== 'ACTIVE' ||
      !Array.isArray(startedGame.players) || startedGame.players.length !== 0 ||
      !Array.isArray(startedGame.purchases) || startedGame.purchases.length !== 0
    ) {
      throw controlledError('PRODUCTION_ACCEPTANCE_GAME_NOT_EMPTY');
    }

    try {
      await dependencies.verifySpectator(origin, auth.cookie, gameId);
    } catch {
      throw controlledError('PUBLIC_WSS_FAILED');
    }

    const voidedGame = await apiRequest(
      origin,
      dependencies.fetchImpl,
      `/api/games/${gameId}/void`,
      {
        method: 'POST',
        expectedStatus: 200,
        errorPrefix: 'PRODUCTION_GAME_VOID_FAILED',
        auth
      }
    );
    gameState = 'VOIDED';
    if (voidedGame.status !== 'VOIDED') {
      throw controlledError('PRODUCTION_GAME_VOID_RESPONSE_INVALID');
    }

    await apiRequest(origin, dependencies.fetchImpl, `/api/users/${temporaryUserId}`, {
      method: 'DELETE',
      expectedStatus: 200,
      errorPrefix: 'PRODUCTION_USER_DELETE_FAILED',
      auth
    });
    temporaryUserDeleted = true;

    report = {
      healthResult: 'PASS',
      loginResult: 'PASS',
      csrfResult: 'PASS',
      passwordChangeResult: 'PASS',
      userCreationResult: 'PASS',
      gameStartResult: 'PASS',
      websocketPresenceResult: 'PASS',
      gameVoidResult: 'PASS',
      userLogicalDeleteResult: 'PASS',
      acceptanceTimestamp: dependencies.now().toISOString()
    };
  } catch (error) {
    primaryError = isControlledError(error)
      ? error
      : controlledError('PRODUCTION_ACCEPTANCE_FAILED');
  } finally {
    if (auth !== undefined && gameId !== undefined) {
      try {
        if (gameState === 'ACTIVE') {
          await apiRequest(origin, dependencies.fetchImpl, `/api/games/${gameId}/void`, {
            method: 'POST',
            expectedStatus: 200,
            errorPrefix: 'PRODUCTION_CLEANUP_GAME_VOID_FAILED',
            auth
          });
          gameState = 'VOIDED';
        } else if (gameState === 'DRAFT') {
          await apiRequest(origin, dependencies.fetchImpl, `/api/games/${gameId}/draft`, {
            method: 'DELETE',
            expectedStatus: 204,
            errorPrefix: 'PRODUCTION_CLEANUP_GAME_DELETE_FAILED',
            auth
          });
          gameState = 'DELETED';
        }
      } catch (error) {
        cleanupError = isControlledError(error)
          ? error
          : controlledError('PRODUCTION_ACCEPTANCE_CLEANUP_FAILED');
      }
    }
    if (auth !== undefined && temporaryUserId !== undefined && !temporaryUserDeleted) {
      try {
        await apiRequest(origin, dependencies.fetchImpl, `/api/users/${temporaryUserId}`, {
          method: 'DELETE',
          expectedStatus: 200,
          errorPrefix: 'PRODUCTION_CLEANUP_USER_DELETE_FAILED',
          auth
        });
        temporaryUserDeleted = true;
      } catch (error) {
        if (cleanupError === undefined) {
          cleanupError = isControlledError(error)
            ? error
            : controlledError('PRODUCTION_ACCEPTANCE_CLEANUP_FAILED');
        }
      }
    }
  }

  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
  return report;
}

function assertRecordValue(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value)) throw controlledError(code);
  return value;
}

export function formatProductionVerificationRecord(evidence) {
  const imageDigest = assertRecordValue(
    evidence.imageDigest,
    /^sha256:[a-f0-9]{64}$/,
    'PRODUCTION_RECORD_IMAGE_DIGEST_INVALID'
  );
  const migrationVersion = assertRecordValue(
    evidence.migrationVersion,
    /^\d{14}_[a-z0-9_]+$/,
    'PRODUCTION_RECORD_MIGRATION_INVALID'
  );
  const healthResult = assertRecordValue(
    evidence.healthResult,
    /^(?:PASS|FAIL)$/,
    'PRODUCTION_RECORD_HEALTH_INVALID'
  );
  const backupResult = assertRecordValue(
    evidence.backupResult,
    /^(?:PASS|FAIL)$/,
    'PRODUCTION_RECORD_BACKUP_INVALID'
  );
  const backupStamp = assertRecordValue(
    evidence.backupStamp,
    /^\d{8}T\d{6}Z$/,
    'PRODUCTION_RECORD_BACKUP_STAMP_INVALID'
  );
  const acceptanceTimestamp = assertRecordValue(
    evidence.acceptanceTimestamp,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    'PRODUCTION_RECORD_TIMESTAMP_INVALID'
  );
  if (new Date(acceptanceTimestamp).toISOString() !== acceptanceTimestamp) {
    throw controlledError('PRODUCTION_RECORD_TIMESTAMP_INVALID');
  }
  if (!Array.isArray(evidence.backupFiles) || evidence.backupFiles.length !== 3) {
    throw controlledError('PRODUCTION_RECORD_BACKUP_FILES_INVALID');
  }
  const expectedNames = new Set([
    `mysql-${backupStamp}.sql.gz`,
    `avatars-${backupStamp}.tar.gz`,
    `manifest-${backupStamp}.txt`
  ]);
  const backupRows = evidence.backupFiles.map((file) => {
    if (
      typeof file !== 'object' || file === null ||
      typeof file.name !== 'string' || !expectedNames.delete(file.name) ||
      typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw controlledError('PRODUCTION_RECORD_BACKUP_FILES_INVALID');
    }
    return `| ${file.name} | ${file.sha256} |`;
  });
  if (expectedNames.size !== 0) throw controlledError('PRODUCTION_RECORD_BACKUP_FILES_INVALID');

  return [
    '# Production Verification',
    '',
    '| Check | Result |',
    '|---|---|',
    `| health | ${healthResult} |`,
    `| backup | ${backupResult} |`,
    '| acceptance | PASS |',
    `| acceptance timestamp | ${acceptanceTimestamp} |`,
    `| image digest | ${imageDigest} |`,
    `| migration version | ${migrationVersion} |`,
    '',
    '| Backup file | SHA-256 |',
    '|---|---|',
    ...backupRows,
    ''
  ].join('\n');
}

export async function writeProductionVerificationRecord(
  environment,
  writeFileImpl = writeFile
) {
  const backupStamp = requiredEnvironment(environment, 'PRODUCTION_BACKUP_STAMP');
  const contents = formatProductionVerificationRecord({
    imageDigest: requiredEnvironment(environment, 'PRODUCTION_IMAGE_DIGEST'),
    migrationVersion: requiredEnvironment(environment, 'PRODUCTION_MIGRATION_VERSION'),
    healthResult: requiredEnvironment(environment, 'PRODUCTION_HEALTH_RESULT'),
    backupResult: requiredEnvironment(environment, 'PRODUCTION_BACKUP_RESULT'),
    backupStamp,
    backupFiles: [
      {
        name: `mysql-${backupStamp}.sql.gz`,
        sha256: requiredEnvironment(environment, 'PRODUCTION_BACKUP_MYSQL_SHA256')
      },
      {
        name: `avatars-${backupStamp}.tar.gz`,
        sha256: requiredEnvironment(environment, 'PRODUCTION_BACKUP_AVATARS_SHA256')
      },
      {
        name: `manifest-${backupStamp}.txt`,
        sha256: requiredEnvironment(environment, 'PRODUCTION_BACKUP_MANIFEST_SHA256')
      }
    ],
    acceptanceTimestamp: requiredEnvironment(environment, 'PRODUCTION_ACCEPTANCE_TIMESTAMP')
  });
  await writeFileImpl(
    new URL('../docs/deployment/production-verification.md', import.meta.url),
    contents,
    'utf8'
  );
}

function publicErrorCode(error) {
  return isControlledError(error) ? error.message : 'PRODUCTION_ACCEPTANCE_FAILED';
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const arguments_ = process.argv.slice(2);
    if (arguments_.length === 1 && arguments_[0] === '--record') {
      await writeProductionVerificationRecord(process.env);
      process.stdout.write('production verification record written\n');
    } else if (arguments_.length === 0) {
      const report = await runProductionAcceptance(process.env);
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      throw controlledError('PRODUCTION_ARGUMENT_INVALID');
    }
  } catch (error) {
    process.stderr.write(`${publicErrorCode(error)}\n`);
    process.exitCode = 1;
  }
}
