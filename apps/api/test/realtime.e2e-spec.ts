import type { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import request, { type Response } from 'supertest';
import { io, type Socket } from 'socket.io-client';
import { afterEach, vi } from 'vitest';
import type {
  GameJoinAck,
  GameLeaveAck,
  GameSnapshotDto,
  ServerErrorEvent
} from '@poker/contracts';
import {
  GameStatus,
  Role,
  type Game,
  type SystemSetting,
  type User
} from '../src/generated/prisma/client.js';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { GameEventsService } from '../src/realtime/game-events.service.js';

const databaseName = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
if (!databaseName.endsWith('_test')) {
  throw new Error(`Realtime E2E tests require an isolated *_test database, got ${databaseName || '(none)'}`);
}

const runId = randomUUID().replaceAll('-', '').slice(0, 10);
const prefix = `realtime-${runId}`;
const password = `${randomBytes(18).toString('base64url')}Aa1!`;

interface AuthContext {
  cookie: string;
  csrfToken: string;
}

function normalize(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function cookieFrom(response: Response): string {
  const header = response.headers['set-cookie'];
  const serialized = Array.isArray(header) ? header[0] : header;
  expect(serialized).toBeDefined();
  return serialized!.split(';', 1)[0]!;
}

function waitForEvent<T>(socket: Socket, event: string, timeout = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeout);
    const onEvent = (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, onEvent);
  });
}

function expectNoEvent(socket: Socket, event: string, duration = 250): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      clearTimeout(timer);
      reject(new Error(`Unexpected ${event}`));
    };
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, duration);
    socket.once(event, onEvent);
  });
}

describe.sequential('realtime game rooms', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let serverUrl: string;
  let passwordHash: string;
  let superUser: User;
  let admin: User;
  let player: User;
  let viewer: User;
  let superAuth: AuthContext;
  let playerAuth: AuthContext;
  let viewerAuth: AuthContext;
  let originalSettings: SystemSetting;
  const sockets = new Set<Socket>();

  async function seedUser(suffix: string, role: Role): Promise<User> {
    const username = `${prefix}-${suffix}`;
    const nickname = `实时-${runId}-${suffix}`;
    return prisma.user.create({
      data: {
        username,
        normalizedUsername: normalize(username),
        nickname,
        activeNormalizedNickname: normalize(nickname),
        passwordHash,
        role,
        avatarValue: 'preset-04'
      }
    });
  }

  async function login(target: User): Promise<AuthContext> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: target.username, password })
      .expect(201);
    return { cookie: cookieFrom(response), csrfToken: response.body.csrfToken };
  }

  function socketFor(cookie?: string): Socket {
    const socket = io(serverUrl, {
      autoConnect: false,
      transports: ['websocket'],
      reconnection: false,
      ...(cookie === undefined ? {} : { extraHeaders: { Cookie: cookie } })
    });
    sockets.add(socket);
    return socket;
  }

  async function connect(socket: Socket): Promise<void> {
    const connected = waitForEvent<void>(socket, 'connect', 10_000);
    socket.connect();
    await connected;
  }

  async function connectError(socket: Socket): Promise<Error> {
    const failed = waitForEvent<Error>(socket, 'connect_error', 10_000);
    socket.connect();
    return failed;
  }

  function join(socket: Socket, gameId: string, knownVersion: number): Promise<GameJoinAck> {
    return new Promise((resolve) => {
      socket.emit('game.join', { gameId, knownVersion }, resolve);
    });
  }

  async function seedGame(suffix: string, status: GameStatus = GameStatus.ACTIVE): Promise<Game> {
    return prisma.game.create({
      data: {
        name: `${prefix}-${suffix}`,
        handPrice: 300n,
        rakeEnabled: true,
        status,
        version: 1,
        createdById: admin.id,
        startedAt: status === GameStatus.DRAFT ? null : new Date(),
        stoppedAt: status === GameStatus.SETTLING ? new Date() : null
      }
    });
  }

  function post(auth: AuthContext, path: string, body: object) {
    return request(app.getHttpServer())
      .post(path)
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrfToken)
      .send(body);
  }

  function patch(auth: AuthContext, path: string, body: object) {
    return request(app.getHttpServer())
      .patch(path)
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrfToken)
      .send(body);
  }

  async function cleanGames(): Promise<void> {
    const gameIds = (await prisma.game.findMany({
      where: { name: { startsWith: prefix } },
      select: { id: true }
    })).map(({ id }) => id);
    if (gameIds.length === 0) return;
    const playerIds = (await prisma.gamePlayer.findMany({
      where: { gameId: { in: gameIds } },
      select: { id: true }
    })).map(({ id }) => id);
    await prisma.auditLog.deleteMany({
      where: { entityType: { in: ['GAME', 'BUYIN_EVENT'] }, entityId: { in: gameIds } }
    });
    await prisma.buyinEvent.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.activePlayerLock.deleteMany({ where: { gameId: { in: gameIds } } });
    if (playerIds.length > 0) {
      await prisma.settlementFeeAllocation.deleteMany({ where: { gamePlayerId: { in: playerIds } } });
      await prisma.settlementResult.deleteMany({ where: { gamePlayerId: { in: playerIds } } });
    }
    await prisma.settlement.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.settlementDraft.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.gamePlayer.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.game.deleteMany({ where: { id: { in: gameIds } } });
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.CSRF_SECRET = randomBytes(32).toString('hex');
    process.env.BOOTSTRAP_ADMIN_USERNAME = `${prefix}-bootstrap`;
    process.env.BOOTSTRAP_ADMIN_NICKNAME = `实时根-${runId}`;
    process.env.BOOTSTRAP_ADMIN_PASSWORD = password;
    app = await createApp();
    prisma = app.get(PrismaService);
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (address === null || typeof address === 'string') throw new Error('Missing test server port');
    serverUrl = `http://127.0.0.1:${address.port}`;
    passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    superUser = await seedUser('super', Role.SUPER_ADMIN);
    admin = await seedUser('admin', Role.ADMIN);
    player = await seedUser('player', Role.USER);
    viewer = await seedUser('viewer', Role.USER);
    originalSettings = await prisma.systemSetting.findUniqueOrThrow({ where: { id: 'singleton' } });
  }, 30_000);

  beforeEach(async () => {
    for (const socket of sockets) socket.disconnect();
    sockets.clear();
    vi.restoreAllMocks();
    await cleanGames();
    await prisma.user.updateMany({
      where: { id: { in: [player.id, viewer.id] } },
      data: {
        isActive: true,
        deletedAt: null,
        passwordHash,
        mustChangePassword: false,
        rakeEnabled: true
      }
    });
    playerAuth = await login(player);
    viewerAuth = await login(viewer);
    superAuth = await login(superUser);
  });

  afterEach(() => {
    for (const socket of sockets) socket.disconnect();
    sockets.clear();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (prisma !== undefined) {
      await cleanGames();
      await prisma.systemSetting.update({
        where: { id: originalSettings.id },
        data: {
          rakeThreshold: originalSettings.rakeThreshold,
          rakeBps: originalSettings.rakeBps,
          version: originalSettings.version,
          updatedById: originalSettings.updatedById,
          updatedAt: originalSettings.updatedAt
        }
      });
      const userIds = (await prisma.user.findMany({
        where: { normalizedUsername: { startsWith: normalize(prefix) } },
        select: { id: true }
      })).map(({ id }) => id);
      await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
      await prisma.authSession.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (app !== undefined) await app.close();
  }, 30_000);

  it.each([
    ['missing cookie', undefined],
    ['forged cookie', 'poker_session=not-a-real-session-token']
  ])('rejects a socket with %s without leaking details', async (_label, cookie) => {
    const error = await connectError(socketFor(cookie));
    expect(error.message).toBe('UNAUTHENTICATED');
    expect(JSON.stringify(error)).not.toContain('tokenHash');
  });

  it.each(['expired', 'revoked', 'disabled'] as const)(
    'rejects a %s authenticated session at the handshake boundary',
    async (state) => {
      if (state === 'expired') {
        await prisma.authSession.updateMany({
          where: { userId: viewer.id, revokedAt: null },
          data: { expiresAt: new Date(Date.now() - 1_000) }
        });
      } else if (state === 'revoked') {
        await prisma.authSession.updateMany({
          where: { userId: viewer.id, revokedAt: null },
          data: { revokedAt: new Date() }
        });
      } else {
        await prisma.user.update({ where: { id: viewer.id }, data: { isActive: false } });
      }
      const error = await connectError(socketFor(viewerAuth.cookie));
      expect(error.message).toBe('UNAUTHENTICATED');
      expect(JSON.stringify(error)).not.toContain(viewer.id);
    }
  );

  it('joins with a canonical payload, sends a missed full snapshot, and acks equal versions', async () => {
    const game = await seedGame('version');
    const socket = socketFor(viewerAuth.cookie);
    await connect(socket);
    const snapshotPromise = waitForEvent<GameSnapshotDto>(socket, 'game.snapshot');
    await expect(join(socket, game.id, 0)).resolves.toMatchObject({
      ok: true,
      gameId: game.id,
      version: 1,
      snapshotSent: true
    });
    expect(await snapshotPromise).toMatchObject({ id: game.id, version: 1 });

    const noSnapshot = expectNoEvent(socket, 'game.snapshot');
    await expect(join(socket, game.id, 1)).resolves.toMatchObject({
      ok: true,
      version: 1,
      snapshotSent: false
    });
    await noSnapshot;

    const serverError = waitForEvent<ServerErrorEvent>(socket, 'server.error');
    await expect(join(socket, game.id.toUpperCase(), 0)).resolves.toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR'
    });
    await expect(serverError).resolves.toEqual({ code: 'VALIDATION_ERROR' });
  });

  it('reference-counts two tabs and cleans leave, disconnect, and room switches', async () => {
    const firstGame = await seedGame('presence-a');
    const secondGame = await seedGame('presence-b');
    const first = socketFor(viewerAuth.cookie);
    const second = socketFor(viewerAuth.cookie);
    await Promise.all([connect(first), connect(second)]);
    await join(first, firstGame.id, 0);
    await join(second, firstGame.id, 0);

    const current = await request(app.getHttpServer())
      .get(`/api/games/${firstGame.id}/snapshot`)
      .set('Cookie', viewerAuth.cookie)
      .expect(200);
    expect(current.body.spectators.filter(({ userId }: { userId: string }) => userId === viewer.id))
      .toHaveLength(1);

    first.disconnect();
    const afterOneClose = await request(app.getHttpServer())
      .get(`/api/games/${firstGame.id}/snapshot`)
      .set('Cookie', viewerAuth.cookie)
      .expect(200);
    expect(afterOneClose.body.spectators.map(({ userId }: { userId: string }) => userId))
      .toContain(viewer.id);

    await join(second, secondGame.id, 0);
    const oldRoom = await request(app.getHttpServer())
      .get(`/api/games/${firstGame.id}/snapshot`)
      .set('Cookie', viewerAuth.cookie)
      .expect(200);
    expect(oldRoom.body.spectators).not.toContainEqual(expect.objectContaining({ userId: viewer.id }));

    const leaveAck = await new Promise<GameLeaveAck>((resolve) => {
      second.emit('game.leave', { gameId: secondGame.id }, resolve);
    });
    expect(leaveAck).toMatchObject({ ok: true, gameId: secondGame.id });
    const newRoom = await request(app.getHttpServer())
      .get(`/api/games/${secondGame.id}/snapshot`)
      .set('Cookie', viewerAuth.cookie)
      .expect(200);
    expect(newRoom.body.spectators).not.toContainEqual(expect.objectContaining({ userId: viewer.id }));
  });

  it('does not list a seated player as a spectator', async () => {
    const game = await seedGame('player-excluded');
    await post(playerAuth, `/api/games/${game.id}/buyins`, {
      hands: 1,
      idempotencyKey: `${prefix}-player-seat`
    }).expect(201);
    const socket = socketFor(playerAuth.cookie);
    await connect(socket);
    const snapshotPromise = waitForEvent<GameSnapshotDto>(socket, 'game.snapshot');
    await join(socket, game.id, 0);
    const snapshot = await snapshotPromise;
    expect(snapshot.players).toContainEqual(expect.objectContaining({ userId: player.id }));
    expect(snapshot.spectators).not.toContainEqual(expect.objectContaining({ userId: player.id }));
  });

  it('emits presence updates when a spectator arrives and their final tab disconnects', async () => {
    const game = await seedGame('presence-events');
    const observer = socketFor(playerAuth.cookie);
    const arriving = socketFor(viewerAuth.cookie);
    await connect(observer);
    await join(observer, game.id, 0);

    const arrived = new Promise<{ spectators: Array<{ userId: string }> }>((resolve) => {
      observer.on('presence.updated', (event: { spectators: Array<{ userId: string }> }) => {
        if (event.spectators.some(({ userId }) => userId === viewer.id)) resolve(event);
      });
    });
    await connect(arriving);
    await join(arriving, game.id, 0);
    await expect(arrived).resolves.toMatchObject({
      spectators: expect.arrayContaining([expect.objectContaining({ userId: viewer.id })])
    });

    const departed = new Promise<{ spectators: Array<{ userId: string }> }>((resolve) => {
      observer.on('presence.updated', (event: { spectators: Array<{ userId: string }> }) => {
        if (!event.spectators.some(({ userId }) => userId === viewer.id)) resolve(event);
      });
    });
    arriving.disconnect();
    await expect(departed).resolves.toMatchObject({
      spectators: expect.not.arrayContaining([expect.objectContaining({ userId: viewer.id })])
    });
  });

  it('does not emit timer ticks and removes an unauthorized completed-game spectator', async () => {
    const game = await seedGame('completed-boundary');
    const socket = socketFor(viewerAuth.cookie);
    await connect(socket);
    await join(socket, game.id, 0);
    const noTick = expectNoEvent(socket, 'timer.tick');
    const forbidden = waitForEvent<ServerErrorEvent>(socket, 'server.error');
    await prisma.game.update({
      where: { id: game.id },
      data: { status: GameStatus.COMPLETED, stoppedAt: new Date(), completedAt: new Date() }
    });
    await app.get(GameEventsService).publishCommittedGame(game.id);
    await expect(forbidden).resolves.toEqual({ code: 'FORBIDDEN' });
    await noTick;
    const snapshot = await request(app.getHttpServer())
      .get(`/api/games/${game.id}/snapshot`)
      .set('Cookie', superAuth.cookie)
      .expect(200);
    expect(snapshot.body.spectators).not.toContainEqual(expect.objectContaining({ userId: viewer.id }));
  });

  it('recovers a 600 yuan missed buy-in from the database after reconnect', async () => {
    const game = await seedGame('reconnect');
    const socket = socketFor(playerAuth.cookie);
    await connect(socket);
    await join(socket, game.id, 1);
    socket.disconnect();
    await post(playerAuth, `/api/games/${game.id}/buyins`, {
      hands: 2,
      idempotencyKey: `${prefix}-missed-buy`
    }).expect(201);

    const reconnected = socketFor(playerAuth.cookie);
    await connect(reconnected);
    const snapshotPromise = waitForEvent<GameSnapshotDto>(reconnected, 'game.snapshot');
    const ack = await join(reconnected, game.id, 1);
    expect(ack).toMatchObject({ ok: true, version: 2, snapshotSent: true });
    const snapshot = await snapshotPromise;
    expect(snapshot.players).toContainEqual(expect.objectContaining({
      userId: player.id,
      buyInAmount: '600'
    }));
  });

  it('isolates rooms and broadcasts only after a successful commit', async () => {
    const firstGame = await seedGame('isolation-a');
    const secondGame = await seedGame('isolation-b');
    const socket = socketFor(viewerAuth.cookie);
    await connect(socket);
    await join(socket, firstGame.id, 1);

    const isolated = expectNoEvent(socket, 'game.updated');
    await post(playerAuth, `/api/games/${secondGame.id}/buyins`, {
      hands: 1,
      idempotencyKey: `${prefix}-other-room`
    }).expect(201);
    await isolated;

    const updated = waitForEvent<GameSnapshotDto>(socket, 'game.updated');
    await post(viewerAuth, `/api/games/${firstGame.id}/buyins`, {
      hands: 1,
      idempotencyKey: `${prefix}-same-room`
    }).expect(201);
    await expect(updated).resolves.toMatchObject({ id: firstGame.id, version: 2 });

    await prisma.game.update({
      where: { id: firstGame.id },
      data: { status: GameStatus.SETTLING, stoppedAt: new Date() }
    });
    const rollbackDidNotBroadcast = expectNoEvent(socket, 'game.updated');
    await post(playerAuth, `/api/games/${firstGame.id}/buyins`, {
      hands: 1,
      idempotencyKey: `${prefix}-rolled-back`
    }).expect(409);
    await rollbackDidNotBroadcast;
  });

  it('does not turn a committed HTTP write into 500 when broadcasting fails', async () => {
    const game = await seedGame('broadcast-failure');
    vi.spyOn(app.get(GameEventsService), 'publishCommittedGame')
      .mockRejectedValueOnce(new Error('synthetic socket failure'));
    await post(playerAuth, `/api/games/${game.id}/buyins`, {
      hands: 1,
      idempotencyKey: `${prefix}-broadcast-failure`
    }).expect(201);
    expect(await prisma.buyinEvent.count({ where: { gameId: game.id } })).toBe(1);
  });

  it('publishes global and active-player rake changes to the affected room', async () => {
    const game = await seedGame('rake');
    await post(playerAuth, `/api/games/${game.id}/buyins`, {
      hands: 1,
      idempotencyKey: `${prefix}-rake-seat`
    }).expect(201);
    const socket = socketFor(viewerAuth.cookie);
    await connect(socket);
    await join(socket, game.id, 0);

    const before = await request(app.getHttpServer())
      .get('/api/settings/rake')
      .set('Cookie', superAuth.cookie)
      .expect(200);
    const globalEvent = waitForEvent<{ version: number }>(socket, 'rake-settings.updated');
    await patch(superAuth, '/api/settings/rake', {
      threshold: before.body.threshold,
      bps: before.body.bps,
      version: before.body.version
    }).expect(200);
    expect(await globalEvent).toEqual({ version: before.body.version + 1 });

    const playerEvent = waitForEvent<{ userId: string }>(socket, 'player-rake.updated');
    await patch(superAuth, `/api/users/${player.id}`, { rakeEnabled: false }).expect(200);
    expect(await playerEvent).toEqual({ userId: player.id });
  });

  it.each(['disable', 'reset-password', 'logout'] as const)(
    'disconnects both tabs and removes presence after %s revokes the session',
    async (operation) => {
      const game = await seedGame(`revoke-${operation}`);
      const first = socketFor(viewerAuth.cookie);
      const second = socketFor(viewerAuth.cookie);
      await Promise.all([connect(first), connect(second)]);
      await Promise.all([join(first, game.id, 0), join(second, game.id, 0)]);
      const firstDisconnected = waitForEvent(first, 'disconnect');
      const secondDisconnected = waitForEvent(second, 'disconnect');

      if (operation === 'disable') {
        await patch(superAuth, `/api/users/${viewer.id}`, { isActive: false }).expect(200);
      } else if (operation === 'reset-password') {
        await post(superAuth, `/api/users/${viewer.id}/reset-password`, {
          newPassword: `${password}Replacement!`
        }).expect(200);
      } else {
        await post(viewerAuth, '/api/auth/logout', {}).expect(200);
      }

      await Promise.all([firstDisconnected, secondDisconnected]);
      const snapshot = await request(app.getHttpServer())
        .get(`/api/games/${game.id}/snapshot`)
        .set('Cookie', superAuth.cookie)
        .expect(200);
      expect(snapshot.body.spectators).not.toContainEqual(expect.objectContaining({ userId: viewer.id }));
    }
  );
});
