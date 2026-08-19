/* global AbortController, URL, clearTimeout, process, setTimeout */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const requireFromWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { io } = requireFromWeb('socket.io-client');
const {
  authSessionResponseSchema,
  canonicalPublicIdSchema,
  gameJoinAckSchema,
  gameLeaveAckSchema,
  gameSnapshotSchema,
  userResponseSchema,
  usersResponseSchema
} = requireFromWeb('@poker/contracts');
const SESSION_COOKIE_NAME = 'poker_session';
const REQUEST_TIMEOUT_MS = 10_000;
const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '');
const COMPOSE_PREFIX = [
  'compose', '--file', 'docker-compose.yml', '--project-name', 'poker-scorekeeper'
];

function controlledError(code, publicDetails) {
  const error = new Error(code);
  if (publicDetails !== undefined) error.publicDetails = publicDetails;
  return error;
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

async function strictResponse(response, schema, code) {
  const body = await responseJson(response, code);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw controlledError(code);
  return parsed.data;
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

function validatedDeploymentId(value, code = 'PRODUCTION_DEPLOYMENT_ID_INVALID') {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{7,63}$/.test(value)) {
    throw controlledError(code);
  }
  return value;
}

async function publicDeploymentId(origin, fetchImpl) {
  const response = await timedFetch(
    fetchImpl,
    new URL('/api/health/deployment', origin),
    { method: 'GET', headers: { Accept: 'application/json' } },
    'PUBLIC_DEPLOYMENT_FAILED_0'
  );
  if (!response.ok) throw statusError('PUBLIC_DEPLOYMENT_FAILED', response.status);
  const body = await responseJson(response, 'PUBLIC_DEPLOYMENT_RESPONSE_INVALID');
  if (Object.keys(body).length !== 1) {
    throw controlledError('PUBLIC_DEPLOYMENT_RESPONSE_INVALID');
  }
  return validatedDeploymentId(body.deploymentId, 'PUBLIC_DEPLOYMENT_RESPONSE_INVALID');
}

async function apiResponse(origin, fetchImpl, path, options) {
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
  return response;
}

async function apiRequest(origin, fetchImpl, path, options) {
  const response = await apiResponse(origin, fetchImpl, path, options);
  return strictResponse(response, options.schema, `${options.errorPrefix}_RESPONSE_INVALID`);
}

function ownedLocation(response, origin, collectionPath, code) {
  const value = response.headers.get('location');
  let location;
  try {
    location = new URL(value, origin);
  } catch {
    throw controlledError(code);
  }
  const prefix = `${collectionPath}/`;
  const parsedId = canonicalPublicIdSchema.safeParse(location.pathname.slice(prefix.length));
  if (
    value === null || location.origin !== origin.origin ||
    !location.pathname.startsWith(prefix) || location.pathname.slice(prefix.length).includes('/') ||
    location.search !== '' || location.hash !== '' || !parsedId.success
  ) {
    throw controlledError(code);
  }
  return parsedId.data;
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
          const parsed = gameJoinAckSchema.safeParse(acknowledgement);
          if (!parsed.success || !parsed.data.ok || parsed.data.gameId !== gameId) {
            finish(controlledError('PUBLIC_WSS_JOIN_FAILED'));
            return;
          }
          socket.emit('game.leave', { gameId }, (leaveAcknowledgement) => {
            const leave = gameLeaveAckSchema.safeParse(leaveAcknowledgement);
            if (!leave.success || !leave.data.ok || leave.data.gameId !== gameId) {
              finish(controlledError('PUBLIC_WSS_LEAVE_FAILED'));
              return;
            }
            finish();
          });
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

function ownershipFailure(code, runId, resources) {
  return controlledError(code, {
    manualCleanupRequired: true,
    acceptanceRunId: runId,
    resources
  });
}

function assertOwnedUser(user, expected, deleted, code) {
  if (
    user.id !== expected.id || user.username !== expected.username ||
    user.nickname !== expected.nickname || user.role !== 'USER' ||
    user.rakeEnabled !== false || user.isActive !== !deleted ||
    (deleted ? user.deletedAt === null : user.deletedAt !== null)
  ) {
    throw controlledError(code);
  }
}

function assertOwnedGame(game, expected, status, code) {
  if (
    game.id !== expected.id || game.name !== expected.name || game.status !== status ||
    game.handPrice !== '300' || game.rakeEnabled !== false ||
    game.players.length !== 0 || game.purchases.length !== 0 || game.spectators.length !== 0
  ) {
    throw controlledError(code);
  }
}

async function assertDeletedUserReadback(origin, fetchImpl, auth, expected, errorPrefix) {
  const listed = await apiRequest(origin, fetchImpl, '/api/users', {
    method: 'GET',
    expectedStatus: 200,
    errorPrefix,
    auth,
    schema: usersResponseSchema.strict()
  });
  const user = listed.users.find(({ id }) => id === expected.id);
  if (user === undefined) throw controlledError(`${errorPrefix}_RESPONSE_INVALID`);
  assertOwnedUser(user, expected, true, `${errorPrefix}_RESPONSE_INVALID`);
}

async function deleteOwnedUser(
  origin,
  fetchImpl,
  auth,
  expected,
  errorPrefix,
  { onResponse, onConfirmed }
) {
  const response = await apiResponse(origin, fetchImpl, `/api/users/${expected.id}`, {
    method: 'DELETE',
    expectedStatus: 200,
    errorPrefix,
    auth
  });
  onResponse();
  let responseError;
  try {
    const deleted = await strictResponse(
      response,
      userResponseSchema.strict(),
      `${errorPrefix}_RESPONSE_INVALID`
    );
    assertOwnedUser(deleted, expected, true, `${errorPrefix}_RESPONSE_INVALID`);
  } catch (error) {
    responseError = error;
  }
  await assertDeletedUserReadback(origin, fetchImpl, auth, expected, `${errorPrefix}_READBACK_FAILED`);
  if (responseError !== undefined) throw responseError;
  onConfirmed();
}

function ownedResourceStates(temporaryUser, temporaryUserState, ownedGame, gameState) {
  const resources = {};
  if (temporaryUser.id !== undefined) {
    resources.user = { id: temporaryUser.id, state: temporaryUserState };
  }
  if (ownedGame.id !== undefined) {
    resources.game = { id: ownedGame.id, state: gameState };
  }
  return resources;
}

function acceptanceFailure(
  primaryError,
  cleanupErrors,
  runId,
  temporaryUser,
  temporaryUserState,
  ownedGame,
  gameState
) {
  const primaryRequiresManualCleanup = primaryError?.publicDetails?.manualCleanupRequired === true;
  const userRequiresManualCleanup = temporaryUser.id !== undefined && temporaryUserState !== 'DELETED';
  const gameRequiresManualCleanup = ownedGame.id !== undefined && !['DELETED', 'VOIDED'].includes(gameState);
  const manualCleanupRequired = (
    primaryRequiresManualCleanup || userRequiresManualCleanup || gameRequiresManualCleanup ||
    cleanupErrors.length > 0
  );

  if (cleanupErrors.length === 0 && !manualCleanupRequired) return primaryError;
  if (cleanupErrors.length === 0 && primaryError?.publicDetails?.manualCleanupRequired === true) {
    return primaryError;
  }

  const details = {
    manualCleanupRequired,
    acceptanceRunId: runId,
    ...(primaryError === undefined ? {} : { primaryError: primaryError.message }),
    cleanupErrors: cleanupErrors.map((error) => error.message),
    ownedResources: ownedResourceStates(
      temporaryUser,
      temporaryUserState,
      ownedGame,
      gameState
    )
  };
  if (Array.isArray(primaryError?.publicDetails?.resources)) {
    details.resources = primaryError.publicDetails.resources;
  }

  if (primaryError !== undefined && cleanupErrors.length > 0) {
    return controlledError('PRODUCTION_ACCEPTANCE_AND_CLEANUP_FAILED', details);
  }
  if (primaryError !== undefined) return controlledError(primaryError.message, details);
  return controlledError('PRODUCTION_ACCEPTANCE_CLEANUP_FAILED', details);
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
  const temporaryUser = {
    id: undefined,
    username: `accept-${runId}`,
    nickname: `验收-${runId}`
  };
  const ownedGame = { id: undefined, name: `生产验收-${runId}` };
  let temporaryUserState;
  let gameState;
  let primaryError;
  const cleanupErrors = [];
  let report;

  try {
    await healthCheck(origin, dependencies.fetchImpl);

    const loginResponse = await timedFetch(dependencies.fetchImpl, new URL('/api/auth/login', origin), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: currentPassword })
    }, 'PRODUCTION_LOGIN_FAILED_0');
    if (loginResponse.status !== 201) throw statusError('PRODUCTION_LOGIN_FAILED', loginResponse.status);
    const login = await strictResponse(
      loginResponse,
      authSessionResponseSchema.strict(),
      'PRODUCTION_LOGIN_RESPONSE_INVALID'
    );
    if (login.user.role !== 'SUPER_ADMIN' || login.user.username !== username) {
      throw controlledError('PRODUCTION_LOGIN_RESPONSE_INVALID');
    }
    auth = { cookie: sessionCookie(loginResponse), csrfToken: login.csrfToken };

    const passwordChange = await apiRequest(origin, dependencies.fetchImpl, '/api/auth/change-password', {
      method: 'POST',
      expectedStatus: 200,
      errorPrefix: 'PRODUCTION_PASSWORD_CHANGE_FAILED',
      auth,
      body: { currentPassword, newPassword },
      schema: authSessionResponseSchema.strict()
    });
    if (
      passwordChange.user.mustChangePassword !== false ||
      passwordChange.user.id !== login.user.id ||
      passwordChange.user.username !== username ||
      passwordChange.user.nickname !== login.user.nickname ||
      passwordChange.user.role !== 'SUPER_ADMIN' ||
      passwordChange.csrfToken !== auth.csrfToken
    ) {
      throw controlledError('PRODUCTION_PASSWORD_CHANGE_RESPONSE_INVALID');
    }

    const createdUserResponse = await apiResponse(origin, dependencies.fetchImpl, '/api/users', {
      method: 'POST',
      expectedStatus: 201,
      errorPrefix: 'PRODUCTION_USER_CREATE_FAILED',
      auth,
      body: {
        username: temporaryUser.username,
        nickname: temporaryUser.nickname,
        initialPassword: temporaryPassword,
        role: 'USER',
        rakeEnabled: false
      }
    });
    try {
      temporaryUser.id = ownedLocation(
        createdUserResponse,
        origin,
        '/api/users',
        'PRODUCTION_USER_OWNERSHIP_UNCONFIRMED'
      );
    } catch {
      throw ownershipFailure('PRODUCTION_USER_OWNERSHIP_UNCONFIRMED', runId, ['TEMPORARY_USER']);
    }
    temporaryUserState = 'ACTIVE';
    const createdUser = await strictResponse(
      createdUserResponse,
      userResponseSchema.strict(),
      'PRODUCTION_USER_CREATE_RESPONSE_INVALID'
    );
    assertOwnedUser(createdUser, temporaryUser, false, 'PRODUCTION_USER_CREATE_RESPONSE_INVALID');
    if (createdUser.mustChangePassword !== true) {
      throw controlledError('PRODUCTION_USER_CREATE_RESPONSE_INVALID');
    }

    const createdGameResponse = await apiResponse(origin, dependencies.fetchImpl, '/api/games', {
      method: 'POST',
      expectedStatus: 201,
      errorPrefix: 'PRODUCTION_GAME_CREATE_FAILED',
      auth,
      body: { name: ownedGame.name, handPrice: '300', rakeEnabled: false }
    });
    try {
      ownedGame.id = ownedLocation(
        createdGameResponse,
        origin,
        '/api/games',
        'PRODUCTION_GAME_OWNERSHIP_UNCONFIRMED'
      );
    } catch {
      throw ownershipFailure('PRODUCTION_GAME_OWNERSHIP_UNCONFIRMED', runId, ['EMPTY_GAME']);
    }
    gameState = 'DRAFT';
    const createdGame = await strictResponse(
      createdGameResponse,
      gameSnapshotSchema.strict(),
      'PRODUCTION_GAME_CREATE_RESPONSE_INVALID'
    );
    assertOwnedGame(createdGame, ownedGame, 'DRAFT', 'PRODUCTION_GAME_CREATE_RESPONSE_INVALID');

    const startedGameResponse = await apiResponse(
      origin,
      dependencies.fetchImpl,
      `/api/games/${ownedGame.id}/start`,
      {
        method: 'POST',
        expectedStatus: 200,
        errorPrefix: 'PRODUCTION_GAME_START_FAILED',
        auth
      }
    );
    gameState = 'ACTIVE';
    const startedGame = await strictResponse(
      startedGameResponse,
      gameSnapshotSchema.strict(),
      'PRODUCTION_GAME_START_RESPONSE_INVALID'
    );
    assertOwnedGame(startedGame, ownedGame, 'ACTIVE', 'PRODUCTION_GAME_START_RESPONSE_INVALID');
    if (startedGame.version !== createdGame.version + 1) {
      throw controlledError('PRODUCTION_GAME_START_RESPONSE_INVALID');
    }

    try {
      await dependencies.verifySpectator(origin, auth.cookie, ownedGame.id);
    } catch {
      throw controlledError('PUBLIC_WSS_FAILED');
    }

    const voidedGameResponse = await apiResponse(
      origin,
      dependencies.fetchImpl,
      `/api/games/${ownedGame.id}/void`,
      {
        method: 'POST',
        expectedStatus: 200,
        errorPrefix: 'PRODUCTION_GAME_VOID_FAILED',
        auth
      }
    );
    gameState = 'VOID_RESPONSE_RECEIVED';
    const voidedGame = await strictResponse(
      voidedGameResponse,
      gameSnapshotSchema.strict(),
      'PRODUCTION_GAME_VOID_RESPONSE_INVALID'
    );
    assertOwnedGame(voidedGame, ownedGame, 'VOIDED', 'PRODUCTION_GAME_VOID_RESPONSE_INVALID');
    if (voidedGame.version !== startedGame.version + 1) {
      throw controlledError('PRODUCTION_GAME_VOID_RESPONSE_INVALID');
    }
    gameState = 'VOIDED';

    await deleteOwnedUser(
      origin,
      dependencies.fetchImpl,
      auth,
      temporaryUser,
      'PRODUCTION_USER_DELETE_FAILED',
      {
        onResponse: () => { temporaryUserState = 'DELETE_RESPONSE_RECEIVED'; },
        onConfirmed: () => { temporaryUserState = 'DELETED'; }
      }
    );

    report = {
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
      acceptanceTimestamp: dependencies.now().toISOString()
    };
  } catch (error) {
    primaryError = isControlledError(error)
      ? error
      : controlledError('PRODUCTION_ACCEPTANCE_FAILED');
  } finally {
    if (auth !== undefined && ownedGame.id !== undefined) {
      try {
        if (gameState === 'ACTIVE') {
          const response = await apiResponse(origin, dependencies.fetchImpl, `/api/games/${ownedGame.id}/void`, {
            method: 'POST',
            expectedStatus: 200,
            errorPrefix: 'PRODUCTION_CLEANUP_GAME_VOID_FAILED',
            auth
          });
          gameState = 'VOID_RESPONSE_RECEIVED';
          const voided = await strictResponse(
            response,
            gameSnapshotSchema.strict(),
            'PRODUCTION_CLEANUP_GAME_VOID_FAILED_RESPONSE_INVALID'
          );
          assertOwnedGame(
            voided,
            ownedGame,
            'VOIDED',
            'PRODUCTION_CLEANUP_GAME_VOID_FAILED_RESPONSE_INVALID'
          );
          gameState = 'VOIDED';
        } else if (gameState === 'DRAFT') {
          await apiResponse(origin, dependencies.fetchImpl, `/api/games/${ownedGame.id}/draft`, {
            method: 'DELETE',
            expectedStatus: 204,
            errorPrefix: 'PRODUCTION_CLEANUP_GAME_DELETE_FAILED',
            auth
          });
          gameState = 'DELETED';
        }
      } catch (error) {
        cleanupErrors.push(isControlledError(error)
          ? error
          : controlledError('PRODUCTION_ACCEPTANCE_CLEANUP_FAILED'));
      }
    }
    if (auth !== undefined && temporaryUser.id !== undefined && temporaryUserState === 'ACTIVE') {
      try {
        await deleteOwnedUser(
          origin,
          dependencies.fetchImpl,
          auth,
          temporaryUser,
          'PRODUCTION_CLEANUP_USER_DELETE_FAILED',
          {
            onResponse: () => { temporaryUserState = 'DELETE_RESPONSE_RECEIVED'; },
            onConfirmed: () => { temporaryUserState = 'DELETED'; }
          }
        );
      } catch (error) {
        cleanupErrors.push(isControlledError(error)
          ? error
          : controlledError('PRODUCTION_ACCEPTANCE_CLEANUP_FAILED'));
      }
    }
  }

  if (primaryError !== undefined || cleanupErrors.length > 0) {
    throw acceptanceFailure(
      primaryError,
      cleanupErrors,
      runId,
      temporaryUser,
      temporaryUserState,
      ownedGame,
      gameState
    );
  }
  return report;
}

function assertRecordValue(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value)) throw controlledError(code);
  return value;
}

function assertPass(value, code) {
  if (value !== 'PASS') throw controlledError(code);
  return value;
}

function parseUtcTimestamp(value, code) {
  assertRecordValue(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, code);
  if (new Date(value).toISOString() !== value) throw controlledError(code);
  return value;
}

export async function collectRepositoryMigrationEvidence(
  migrationsRoot = new URL('../apps/api/prisma/migrations/', import.meta.url)
) {
  const entries = await readdir(migrationsRoot, { withFileTypes: true });
  const migrations = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{14}_[a-z0-9_]+$/.test(entry.name)) continue;
    const sql = await readFile(new URL(`${entry.name}/migration.sql`, migrationsRoot));
    migrations.push({
      name: entry.name,
      checksum: createHash('sha256').update(sql).digest('hex')
    });
  }
  migrations.sort((left, right) => left.name.localeCompare(right.name));
  if (migrations.length === 0) throw controlledError('PRODUCTION_MIGRATION_REPOSITORY_EMPTY');
  return migrations;
}

function defaultRunCommand(command, arguments_, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      ...options,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function productionCommandOptions() {
  const environment = { ...process.env };
  delete environment.COMPOSE_FILE;
  delete environment.COMPOSE_PROJECT_NAME;
  return { cwd: REPOSITORY_ROOT, env: environment };
}

function composeCommand(...arguments_) {
  return [...COMPOSE_PREFIX, ...arguments_];
}

async function checkedCommand(runCommand, arguments_, code) {
  let result;
  try {
    result = await runCommand('docker', arguments_, productionCommandOptions());
  } catch {
    throw controlledError(code);
  }
  if (
    typeof result !== 'object' || result === null || result.exitCode !== 0 ||
    typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
  ) {
    throw controlledError(code);
  }
  return result.stdout.trim();
}

function versionAtLeast(value, required) {
  const parsed = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (parsed === null) return false;
  const actual = parsed.slice(1, 4).map(Number);
  for (let index = 0; index < required.length; index += 1) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
}

async function probeDocker(runCommand) {
  const engine = await checkedCommand(
    runCommand,
    ['version', '--format', '{{.Server.Version}}'],
    'PRODUCTION_DOCKER_UNAVAILABLE'
  );
  if (!versionAtLeast(engine, [1, 0, 0])) throw controlledError('PRODUCTION_DOCKER_UNAVAILABLE');
  const compose = await checkedCommand(
    runCommand,
    composeCommand('version', '--short'),
    'PRODUCTION_COMPOSE_UNAVAILABLE'
  );
  if (!versionAtLeast(compose, [2, 34, 0])) throw controlledError('PRODUCTION_COMPOSE_TOO_OLD');
}

function parseMigrationRows(output) {
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    throw controlledError('PRODUCTION_MIGRATION_EVIDENCE_INVALID');
  }
  if (!Array.isArray(payload?.migrations)) {
    throw controlledError('PRODUCTION_MIGRATION_EVIDENCE_INVALID');
  }
  return payload.migrations.map((migration) => {
    if (
      typeof migration !== 'object' || migration === null ||
      typeof migration.name !== 'string' || !/^\d{14}_[a-z0-9_]+$/.test(migration.name) ||
      typeof migration.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(migration.checksum)
    ) {
      throw controlledError('PRODUCTION_MIGRATION_EVIDENCE_INVALID');
    }
    return { name: migration.name, checksum: migration.checksum };
  });
}

function parseChecksumRows(output, expectedNames, code) {
  const rows = output.trim().split(/\r?\n/).map((line) => {
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9_.-]+)$/.exec(line);
    if (match === null || !expectedNames.has(match[2])) throw controlledError(code);
    return { name: match[2], sha256: match[1] };
  });
  if (rows.length !== expectedNames.size || new Set(rows.map(({ name }) => name)).size !== rows.length) {
    throw controlledError(code);
  }
  return rows;
}

function assertAcceptanceEvidence(report) {
  if (typeof report !== 'object' || report === null) {
    throw controlledError('PRODUCTION_RECORD_ACCEPTANCE_INVALID');
  }
  for (const key of [
    'acceptanceResult', 'healthResult', 'loginResult', 'csrfResult',
    'passwordChangeResult', 'userCreationResult', 'gameStartResult',
    'websocketPresenceResult', 'gameVoidResult', 'userLogicalDeleteResult'
  ]) {
    assertPass(report[key], 'PRODUCTION_RECORD_ACCEPTANCE_INVALID');
  }
  return parseUtcTimestamp(report.acceptanceTimestamp, 'PRODUCTION_RECORD_TIMESTAMP_INVALID');
}

export async function runProductionVerification(environment, overrides = {}) {
  const runCommand = overrides.runCommand ?? defaultRunCommand;
  await probeDocker(runCommand);

  const taggedImageDigest = await checkedCommand(
    runCommand,
    ['image', 'inspect', 'poker-scorekeeper:local', '--format', '{{.Id}}'],
    'PRODUCTION_IMAGE_INSPECT_FAILED'
  );
  assertRecordValue(
    taggedImageDigest,
    /^sha256:[a-f0-9]{64}$/,
    'PRODUCTION_RECORD_IMAGE_DIGEST_INVALID'
  );
  const imageDeploymentId = validatedDeploymentId(await checkedCommand(
    runCommand,
    ['image', 'inspect', 'poker-scorekeeper:local', '--format',
      '{{index .Config.Labels "org.opencontainers.image.revision"}}'],
    'PRODUCTION_IMAGE_DEPLOYMENT_ID_FAILED'
  ));
  const containerId = await checkedCommand(
    runCommand,
    composeCommand('ps', '-q', 'app'),
    'PRODUCTION_CONTAINER_INSPECT_FAILED'
  );
  assertRecordValue(
    containerId,
    /^[a-f0-9]{12,64}$/,
    'PRODUCTION_CONTAINER_INSPECT_FAILED'
  );
  const runtime = await checkedCommand(
    runCommand,
    ['inspect', containerId, '--format',
      '{{.Image}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}'],
    'PRODUCTION_CONTAINER_INSPECT_FAILED'
  );
  const runtimeMatch = /^(sha256:[a-f0-9]{64}) running healthy$/.exec(runtime);
  if (runtimeMatch === null || runtimeMatch[1] !== taggedImageDigest) {
    throw controlledError('PRODUCTION_CONTAINER_IMAGE_MISMATCH');
  }
  const imageDigest = runtimeMatch[1];
  const containerDeploymentId = validatedDeploymentId(await checkedCommand(
    runCommand,
    composeCommand('exec', '-T', 'app', 'cat', '/app/deployment-id'),
    'PRODUCTION_CONTAINER_DEPLOYMENT_ID_FAILED'
  ));
  if (containerDeploymentId !== imageDeploymentId) {
    throw controlledError('PRODUCTION_DEPLOYMENT_MISMATCH');
  }

  const migrationStatus = await checkedCommand(
    runCommand,
    composeCommand('exec', '-T', 'app', 'pnpm', '--dir', 'apps/api', 'exec', 'prisma', 'migrate', 'status'),
    'PRODUCTION_MIGRATION_STATUS_FAILED'
  );
  if (!migrationStatus.includes('Database schema is up to date')) {
    throw controlledError('PRODUCTION_MIGRATION_STATUS_INVALID');
  }
  const appliedMigrations = parseMigrationRows(await checkedCommand(
    runCommand,
    composeCommand('exec', '-T', 'app', 'node', 'scripts/database/production-migration-evidence.mjs'),
    'PRODUCTION_MIGRATION_EVIDENCE_FAILED'
  ));
  const repositoryMigrations = await (overrides.repositoryMigrations ?? collectRepositoryMigrationEvidence)();
  if (JSON.stringify(appliedMigrations) !== JSON.stringify(repositoryMigrations)) {
    throw controlledError('PRODUCTION_MIGRATION_CHECKSUM_MISMATCH');
  }
  const lastMigration = repositoryMigrations.at(-1);

  const origin = assertPublicOrigin(requiredEnvironment(environment, 'PUBLIC_ORIGIN'));
  await healthCheck(origin, overrides.fetchImpl ?? globalThis.fetch);
  const publicDeployment = await publicDeploymentId(
    origin,
    overrides.fetchImpl ?? globalThis.fetch
  );
  if (publicDeployment !== containerDeploymentId) {
    throw controlledError('PRODUCTION_DEPLOYMENT_MISMATCH');
  }

  const acceptance = await (overrides.acceptanceRunner ?? runProductionAcceptance)(
    environment,
    overrides.acceptanceOverrides ?? {}
  );
  const acceptanceTimestamp = assertAcceptanceEvidence(acceptance);

  await checkedCommand(
    runCommand,
    composeCommand('exec', '-T', 'app', 'node', 'scripts/database/production-backup-target.mjs'),
    'PRODUCTION_BACKUP_TARGET_INVALID'
  );
  await checkedCommand(
    runCommand,
    composeCommand('exec', '-T', 'app', 'sh', 'scripts/backup/backup.sh'),
    'PRODUCTION_BACKUP_FAILED'
  );
  const backupStamp = await checkedCommand(
    runCommand,
    composeCommand('exec', '-T', 'app', 'cat', '/data/backups/latest-stamp'),
    'PRODUCTION_BACKUP_STAMP_FAILED'
  );
  assertRecordValue(backupStamp, /^\d{8}T\d{6}Z$/, 'PRODUCTION_RECORD_BACKUP_STAMP_INVALID');
  const expectedNames = new Set([
    `mysql-${backupStamp}.sql.gz`,
    `avatars-${backupStamp}.tar.gz`,
    `manifest-${backupStamp}.txt`
  ]);
  const recordedChecksums = parseChecksumRows(await checkedCommand(
    runCommand,
    composeCommand('exec', '-T', 'app', 'cat', `/data/backups/checksums-${backupStamp}.txt`),
    'PRODUCTION_BACKUP_CHECKSUM_FAILED'
  ), expectedNames, 'PRODUCTION_BACKUP_CHECKSUM_INVALID');
  const recomputedChecksums = parseChecksumRows(await checkedCommand(
    runCommand,
    composeCommand('exec', '-T', 'app', 'sh', '-c',
      `cd /data/backups && sha256sum mysql-${backupStamp}.sql.gz avatars-${backupStamp}.tar.gz manifest-${backupStamp}.txt`),
    'PRODUCTION_BACKUP_RECHECK_FAILED'
  ), expectedNames, 'PRODUCTION_BACKUP_RECHECK_INVALID');
  if (JSON.stringify(recordedChecksums) !== JSON.stringify(recomputedChecksums)) {
    throw controlledError('PRODUCTION_BACKUP_CHECKSUM_MISMATCH');
  }

  return {
    deploymentId: containerDeploymentId,
    imageDigest,
    migrationVersion: lastMigration.name,
    migrationChecksum: lastMigration.checksum,
    migrationResult: 'PASS',
    healthResult: 'PASS',
    backupResult: 'PASS',
    acceptanceResult: 'PASS',
    backupStamp,
    backupFiles: recordedChecksums,
    acceptanceTimestamp
  };
}

export function formatProductionVerificationRecord(evidence) {
  const deploymentId = validatedDeploymentId(
    evidence.deploymentId,
    'PRODUCTION_RECORD_DEPLOYMENT_ID_INVALID'
  );
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
  const migrationChecksum = assertRecordValue(
    evidence.migrationChecksum,
    /^[a-f0-9]{64}$/,
    'PRODUCTION_RECORD_MIGRATION_CHECKSUM_INVALID'
  );
  const migrationResult = assertPass(evidence.migrationResult, 'PRODUCTION_RECORD_MIGRATION_INVALID');
  const healthResult = assertPass(evidence.healthResult, 'PRODUCTION_RECORD_HEALTH_INVALID');
  const backupResult = assertPass(evidence.backupResult, 'PRODUCTION_RECORD_BACKUP_INVALID');
  const acceptanceResult = assertPass(
    evidence.acceptanceResult,
    'PRODUCTION_RECORD_ACCEPTANCE_INVALID'
  );
  const backupStamp = assertRecordValue(
    evidence.backupStamp,
    /^\d{8}T\d{6}Z$/,
    'PRODUCTION_RECORD_BACKUP_STAMP_INVALID'
  );
  const acceptanceTimestamp = parseUtcTimestamp(
    evidence.acceptanceTimestamp,
    'PRODUCTION_RECORD_TIMESTAMP_INVALID'
  );
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
    `| acceptance | ${acceptanceResult} |`,
    `| migration | ${migrationResult} |`,
    `| acceptance timestamp | ${acceptanceTimestamp} |`,
    `| deployment ID | ${deploymentId} |`,
    `| image digest | ${imageDigest} |`,
    `| migration version | ${migrationVersion} |`,
    `| migration checksum | ${migrationChecksum} |`,
    '',
    '| Backup file | SHA-256 |',
    '|---|---|',
    ...backupRows,
    ''
  ].join('\n');
}

export async function writeProductionVerificationRecord(
  evidence,
  overrides = {}
) {
  const contents = formatProductionVerificationRecord(evidence);
  const target = new URL('../docs/deployment/production-verification.md', import.meta.url);
  const temp = new URL(
    `production-verification.${process.pid}.${(overrides.randomId ?? randomUUID)()}.tmp`,
    target
  );
  const openImpl = overrides.openImpl ?? open;
  const renameImpl = overrides.renameImpl ?? rename;
  const rmImpl = overrides.rmImpl ?? rm;
  let handle;
  let published = false;
  try {
    handle = await openImpl(temp, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameImpl(temp, target);
    published = true;
  } catch {
    throw controlledError('PRODUCTION_RECORD_WRITE_FAILED');
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    if (!published) await rmImpl(temp, { force: true }).catch(() => undefined);
  }
}

function publicErrorCode(error) {
  return isControlledError(error) ? error.message : 'PRODUCTION_ACCEPTANCE_FAILED';
}

function publicErrorOutput(error) {
  const code = publicErrorCode(error);
  if (typeof error?.publicDetails !== 'object' || error.publicDetails === null) return code;
  return JSON.stringify({ code, ...error.publicDetails });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const arguments_ = process.argv.slice(2);
    if (arguments_.length === 1 && arguments_[0] === '--record') {
      const evidence = await runProductionVerification(process.env);
      await writeProductionVerificationRecord(evidence);
      process.stdout.write('production verification record written\n');
    } else if (arguments_.length === 0) {
      const report = await runProductionAcceptance(process.env);
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      throw controlledError('PRODUCTION_ARGUMENT_INVALID');
    }
  } catch (error) {
    process.stderr.write(`${publicErrorOutput(error)}\n`);
    process.exitCode = 1;
  }
}
