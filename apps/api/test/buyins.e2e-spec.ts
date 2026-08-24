import type { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import request, { type Response } from 'supertest';
import { GameStatus, Role, type Game, type User } from '../src/generated/prisma/client.js';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { requireAuthorizedTestDatabase } from './support/authorized-test-database.js';

requireAuthorizedTestDatabase();

const runId = randomUUID().replaceAll('-', '').slice(0, 10);
const prefix = `buyin-http-${runId}`;
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

describe.sequential('buy-in HTTP ledger', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let passwordHash: string;
  let admin: User;
  let player: User;
  let otherPlayer: User;
  let playerAuth: AuthContext;
  let otherAuth: AuthContext;

  async function seedUser(suffix: string, role: Role = Role.USER): Promise<User> {
    const username = `${prefix}-${suffix}`;
    const nickname = `买入-${runId}-${suffix}`;
    return prisma.user.create({
      data: {
        username,
        normalizedUsername: normalize(username),
        nickname,
        activeNormalizedNickname: normalize(nickname),
        passwordHash,
        role,
        avatarValue: 'preset-03'
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

  function post(auth: AuthContext, path: string, body: object) {
    return request(app.getHttpServer())
      .post(path)
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrfToken)
      .send(body);
  }

  async function seedGame(
    suffix: string,
    status: GameStatus = GameStatus.ACTIVE,
    handPrice = 300n
  ): Promise<Game> {
    return prisma.game.create({
      data: {
        name: `${prefix}-${suffix}`,
        handPrice,
        rakeEnabled: true,
        status,
        version: 1,
        createdById: admin.id,
        startedAt: status === GameStatus.DRAFT ? null : new Date(),
        stoppedAt: status === GameStatus.SETTLING ? new Date() : null
      }
    });
  }

  async function cleanGames(): Promise<void> {
    const games = await prisma.game.findMany({
      where: { name: { startsWith: prefix } },
      select: { id: true }
    });
    const gameIds = games.map(({ id }) => id);
    if (gameIds.length === 0) return;
    const events = await prisma.buyinEvent.findMany({
      where: { gameId: { in: gameIds } },
      select: { id: true }
    });
    const eventIds = events.map(({ id }) => id);
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { entityType: 'GAME', entityId: { in: gameIds } },
          ...(eventIds.length === 0 ? [] : [{ entityType: 'BUYIN_EVENT', entityId: { in: eventIds } }])
        ]
      }
    });
    await prisma.buyinEvent.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.activePlayerLock.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.gamePlayer.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.game.deleteMany({ where: { id: { in: gameIds } } });
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.CSRF_SECRET = randomBytes(32).toString('hex');
    process.env.BOOTSTRAP_ADMIN_USERNAME = `${prefix}-bootstrap`;
    process.env.BOOTSTRAP_ADMIN_NICKNAME = `买入根-${runId}`;
    process.env.BOOTSTRAP_ADMIN_PASSWORD = password;
    app = await createApp();
    prisma = app.get(PrismaService);
    await app.init();
    passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    admin = await seedUser('admin', Role.ADMIN);
    player = await seedUser('player');
    otherPlayer = await seedUser('other');
    playerAuth = await login(player);
    otherAuth = await login(otherPlayer);
  }, 30_000);

  beforeEach(async () => {
    await cleanGames();
    player = await prisma.user.update({
      where: { id: player.id },
      data: {
        nickname: player.nickname,
        activeNormalizedNickname: normalize(player.nickname),
        avatarValue: 'preset-03'
      }
    });
  });

  afterAll(async () => {
    if (prisma !== undefined) {
      await cleanGames();
      const users = await prisma.user.findMany({
        where: { normalizedUsername: { startsWith: normalize(prefix) } },
        select: { id: true }
      });
      const userIds = users.map(({ id }) => id);
      if (userIds.length > 0) {
        await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
        await prisma.authSession.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.activePlayerLock.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
    }
    if (app !== undefined) await app.close();
  }, 30_000);

  it('requires authentication and CSRF protection', async () => {
    const game = await seedGame('auth');
    await request(app.getHttpServer())
      .post(`/api/games/${game.id}/buyins`)
      .send({ hands: 1, idempotencyKey: randomUUID() })
      .expect(401)
      .expect(({ body }) => expect(body.code).toBe('UNAUTHENTICATED'));
    await request(app.getHttpServer())
      .post(`/api/games/${game.id}/buyins`)
      .set('Cookie', playerAuth.cookie)
      .send({ hands: 1, idempotencyKey: randomUUID() })
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('CSRF_INVALID'));
  });

  it.each([
    ['zero hands', { hands: 0, idempotencyKey: randomUUID() }],
    ['too many hands', { hands: 100, idempotencyKey: randomUUID() }],
    ['fractional hands', { hands: 1.5, idempotencyKey: randomUUID() }],
    ['missing key', { hands: 1 }],
    ['oversized key', { hands: 1, idempotencyKey: 'x'.repeat(129) }],
    ['uppercase key', { hands: 1, idempotencyKey: 'Request-123' }],
    ['space-suffixed key', { hands: 1, idempotencyKey: 'request-123 ' }],
    ['non-ASCII key', { hands: 1, idempotencyKey: '请求-123' }],
    ['unknown field', { hands: 1, idempotencyKey: randomUUID(), surprise: true }]
  ])('rejects %s before writing', async (_label, body) => {
    const game = await seedGame(`invalid-${_label}`);
    await post(playerAuth, `/api/games/${game.id}/buyins`, body)
      .expect(400)
      .expect(({ body: response }) => expect(response.code).toBe('VALIDATION_ERROR'));
    await expect(prisma.buyinEvent.count({ where: { gameId: game.id } })).resolves.toBe(0);
  });

  it.each([
    ['uppercase player id', (id: string) => id.toUpperCase()],
    ['space-suffixed player id', (id: string) => `${id}%20`]
  ])('rejects %s before appending an adjustment', async (_label, mutateId) => {
    const game = await seedGame(`invalid-player-route-${_label}`);
    const adjustmentKey = `${prefix}-invalid-player-adjust`;
    const bought = await post(playerAuth, `/api/games/${game.id}/buyins`, {
      hands: 2,
      idempotencyKey: `${prefix}-invalid-player-seed`
    }).expect(201);
    await post(
      playerAuth,
      `/api/games/${game.id}/players/${mutateId(bought.body.playerId)}/buyins/latest/adjust`,
      { newHands: 1, idempotencyKey: adjustmentKey }
    ).expect(400).expect(({ body }) => expect(body.code).toBe('VALIDATION_ERROR'));
    await expect(prisma.buyinEvent.count({ where: { gameId: game.id } })).resolves.toBe(1);
    await expect(prisma.auditLog.count({
      where: {
        action: 'BUYIN_ADJUSTED',
        entityType: 'BUYIN_EVENT',
        requestId: adjustmentKey
      }
    })).resolves.toBe(0);
    await expect(prisma.game.findUniqueOrThrow({ where: { id: game.id } }))
      .resolves.toMatchObject({ version: 2 });
  });

  it.each([
    ['uppercase game id', (id: string) => id.toUpperCase()],
    ['space-suffixed game id', (id: string) => `${id}%20`]
  ])('rejects %s before creating a lock, player, or event', async (_label, mutateId) => {
    const game = await seedGame(`invalid-route-${_label}`);
    await post(playerAuth, `/api/games/${mutateId(game.id)}/buyins`, {
      hands: 1,
      idempotencyKey: `${prefix}-invalid-route`
    }).expect(400).expect(({ body }) => expect(body.code).toBe('VALIDATION_ERROR'));
    await expect(prisma.activePlayerLock.findUnique({ where: { userId: player.id } }))
      .resolves.toBeNull();
    await expect(prisma.gamePlayer.count({ where: { gameId: game.id } })).resolves.toBe(0);
    await expect(prisma.buyinEvent.count({ where: { gameId: game.id } })).resolves.toBe(0);
  });

  it('creates the first player with current profile snapshots and the smallest empty seat', async () => {
    const game = await seedGame('first');
    const seatOneUser = await seedUser('seat-one');
    const seatThreeUser = await seedUser('seat-three');
    await prisma.gamePlayer.createMany({
      data: [
        {
          gameId: game.id,
          userId: seatOneUser.id,
          nicknameSnapshot: seatOneUser.nickname,
          avatarKindSnapshot: seatOneUser.avatarKind,
          avatarValueSnapshot: seatOneUser.avatarValue,
          seatNo: 1,
          firstBuyinAt: new Date()
        },
        {
          gameId: game.id,
          userId: seatThreeUser.id,
          nicknameSnapshot: seatThreeUser.nickname,
          avatarKindSnapshot: seatThreeUser.avatarKind,
          avatarValueSnapshot: seatThreeUser.avatarValue,
          seatNo: 3,
          firstBuyinAt: new Date()
        }
      ]
    });

    const response = await post(playerAuth, `/api/games/${game.id}/buyins`, {
      hands: 3,
      idempotencyKey: `${prefix}-first-key`
    }).expect(201);

    expect(response.body).toMatchObject({
      gameId: game.id,
      actorUserId: player.id,
      type: 'BUY',
      previousHands: null,
      newHands: 3,
      handsDelta: 3,
      replayed: false,
      gameVersion: 2
    });
    const storedPlayer = await prisma.gamePlayer.findUniqueOrThrow({
      where: { gameId_userId: { gameId: game.id, userId: player.id } }
    });
    expect(storedPlayer).toMatchObject({
      id: response.body.playerId,
      nicknameSnapshot: player.nickname,
      avatarKindSnapshot: player.avatarKind,
      avatarValueSnapshot: 'preset-03',
      seatNo: 2
    });
    await expect(prisma.activePlayerLock.findUnique({ where: { userId: player.id } }))
      .resolves.toMatchObject({ gameId: game.id });
    await expect(prisma.auditLog.count({
      where: { action: 'BUYIN_BOUGHT', entityId: response.body.eventId }
    })).resolves.toBe(1);
  });

  it('replays an identical key without another event, audit, or version increment', async () => {
    const game = await seedGame('replay');
    const body = { hands: 5, idempotencyKey: `${prefix}-replay-key` };
    const first = await post(playerAuth, `/api/games/${game.id}/buyins`, body).expect(201);
    await post(playerAuth, `/api/games/${game.id}/buyins`, {
      hands: 1,
      idempotencyKey: `${prefix}-replay-later-1`
    }).expect(201);
    await post(playerAuth, `/api/games/${game.id}/buyins`, {
      hands: 2,
      idempotencyKey: `${prefix}-replay-later-2`
    }).expect(201);
    const second = await post(playerAuth, `/api/games/${game.id}/buyins`, body).expect(200);

    expect(second.body).toEqual({ ...first.body, replayed: true });
    await expect(prisma.buyinEvent.count({ where: { gameId: game.id } })).resolves.toBe(3);
    await expect(prisma.auditLog.count({
      where: { action: 'BUYIN_BOUGHT', entityId: first.body.eventId }
    })).resolves.toBe(1);
    await expect(prisma.game.findUniqueOrThrow({ where: { id: game.id } }))
      .resolves.toMatchObject({ version: 4 });
  });

  it('binds an idempotency key to actor, route, game, player, operation, and payload', async () => {
    const firstGame = await seedGame('binding-a');
    const secondGame = await seedGame('binding-b');
    const key = `${prefix}-binding-key`;
    await post(playerAuth, `/api/games/${firstGame.id}/buyins`, { hands: 2, idempotencyKey: key })
      .expect(201);

    for (const makeCall of [
      () => post(playerAuth, `/api/games/${firstGame.id}/buyins`, { hands: 3, idempotencyKey: key }),
      () => post(playerAuth, `/api/games/${secondGame.id}/buyins`, { hands: 2, idempotencyKey: key }),
      () => post(otherAuth, `/api/games/${firstGame.id}/buyins`, { hands: 2, idempotencyKey: key })
    ]) {
      await makeCall()
        .expect(409)
        .expect(({ body }) => expect(body.code).toBe('BUYIN_IDEMPOTENCY_CONFLICT'));
    }
    await expect(prisma.buyinEvent.count({ where: { idempotencyKey: key } })).resolves.toBe(1);
  });

  it('adds later BUY events to the same player without changing its profile snapshot', async () => {
    const game = await seedGame('repeat-buy');
    await post(playerAuth, `/api/games/${game.id}/buyins`, {
      hands: 2,
      idempotencyKey: `${prefix}-repeat-buy-1`
    }).expect(201);
    await prisma.user.update({
      where: { id: player.id },
      data: { nickname: `新昵称-${runId}`, avatarValue: 'preset-09' }
    });
    await post(playerAuth, `/api/games/${game.id}/buyins`, {
      hands: 1,
      idempotencyKey: `${prefix}-repeat-buy-2`
    }).expect(201);

    const players = await prisma.gamePlayer.findMany({ where: { gameId: game.id } });
    expect(players).toHaveLength(1);
    expect(players[0]).toMatchObject({ nicknameSnapshot: player.nickname, avatarValueSnapshot: 'preset-03' });
    await expect(prisma.buyinEvent.count({ where: { gameId: game.id } })).resolves.toBe(2);
  });

  it('appends repeated ADJUST events for only the current user latest logical BUY', async () => {
    const game = await seedGame('adjust');
    await post(playerAuth, `/api/games/${game.id}/buyins`, {
      hands: 2,
      idempotencyKey: `${prefix}-old-buy`
    }).expect(201);
    const latest = await post(playerAuth, `/api/games/${game.id}/buyins`, {
      hands: 5,
      idempotencyKey: `${prefix}-latest-buy`
    }).expect(201);

    const firstAdjust = await post(
      playerAuth,
      `/api/games/${game.id}/players/${latest.body.playerId}/buyins/latest/adjust`,
      { newHands: 3, idempotencyKey: `${prefix}-adjust-1` }
    ).expect(201);
    const secondAdjust = await post(
      playerAuth,
      `/api/games/${game.id}/players/${latest.body.playerId}/buyins/latest/adjust`,
      { newHands: 4, idempotencyKey: `${prefix}-adjust-2` }
    ).expect(201);

    expect(firstAdjust.body).toMatchObject({
      type: 'ADJUST',
      logicalBuyId: latest.body.logicalBuyId,
      previousHands: 5,
      newHands: 3,
      handsDelta: -2
    });
    expect(secondAdjust.body).toMatchObject({
      type: 'ADJUST',
      logicalBuyId: latest.body.logicalBuyId,
      previousHands: 3,
      newHands: 4,
      handsDelta: 1
    });
    const events = await prisma.buyinEvent.findMany({
      where: { gameId: game.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    });
    expect(events.map((event) => ({
      type: event.type,
      logicalBuyId: event.logicalBuyId,
      previousHands: event.previousHands,
      newHands: event.newHands,
      handsDelta: event.handsDelta
    }))).toEqual([
      { type: 'BUY', logicalBuyId: events[0]!.id, previousHands: null, newHands: 2, handsDelta: 2 },
      { type: 'BUY', logicalBuyId: latest.body.logicalBuyId, previousHands: null, newHands: 5, handsDelta: 5 },
      { type: 'ADJUST', logicalBuyId: latest.body.logicalBuyId, previousHands: 5, newHands: 3, handsDelta: -2 },
      { type: 'ADJUST', logicalBuyId: latest.body.logicalBuyId, previousHands: 3, newHands: 4, handsDelta: 1 }
    ]);
  });

  it('rejects adjustment of another player and accepts zero for the owner', async () => {
    const game = await seedGame('owner-only');
    const bought = await post(playerAuth, `/api/games/${game.id}/buyins`, {
      hands: 1,
      idempotencyKey: `${prefix}-owner-buy`
    }).expect(201);
    await post(otherAuth, `/api/games/${game.id}/players/${bought.body.playerId}/buyins/latest/adjust`, {
      newHands: 0,
      idempotencyKey: `${prefix}-other-adjust`
    }).expect(403).expect(({ body }) => expect(body.code).toBe('FORBIDDEN'));
    await post(playerAuth, `/api/games/${game.id}/players/${bought.body.playerId}/buyins/latest/adjust`, {
      newHands: 0,
      idempotencyKey: `${prefix}-zero-adjust`
    }).expect(201).expect(({ body }) => expect(body).toMatchObject({
      previousHands: 1,
      newHands: 0,
      handsDelta: -1
    }));
  });

  it('accepts writes only while the game is ACTIVE', async () => {
    const draft = await seedGame('draft', GameStatus.DRAFT);
    const settling = await seedGame('settling', GameStatus.SETTLING);
    await post(playerAuth, `/api/games/${draft.id}/buyins`, {
      hands: 1,
      idempotencyKey: `${prefix}-draft-buy`
    }).expect(409).expect(({ body }) => expect(body.code).toBe('GAME_STATE_CONFLICT'));
    await post(playerAuth, `/api/games/${settling.id}/buyins`, {
      hands: 1,
      idempotencyKey: `${prefix}-settling-buy`
    }).expect(409).expect(({ body }) => expect(body.code).toBe('GAME_STATE_CONFLICT'));
  });

  it('limits a table to 12 players without leaving partial rows', async () => {
    const game = await seedGame('full');
    for (let seatNo = 1; seatNo <= 12; seatNo += 1) {
      const seated = await seedUser(`full-${seatNo}`);
      await prisma.gamePlayer.create({
        data: {
          gameId: game.id,
          userId: seated.id,
          nicknameSnapshot: seated.nickname,
          avatarKindSnapshot: seated.avatarKind,
          avatarValueSnapshot: seated.avatarValue,
          seatNo,
          firstBuyinAt: new Date()
        }
      });
    }
    await post(playerAuth, `/api/games/${game.id}/buyins`, {
      hands: 1,
      idempotencyKey: `${prefix}-full-buy`
    }).expect(409).expect(({ body }) => expect(body.code).toBe('GAME_PLAYER_LIMIT'));
    await expect(prisma.gamePlayer.count({ where: { gameId: game.id } })).resolves.toBe(12);
    await expect(prisma.buyinEvent.count({ where: { gameId: game.id } })).resolves.toBe(0);
    await expect(prisma.activePlayerLock.findUnique({ where: { userId: player.id } })).resolves.toBeNull();
  });

  it('rejects signed BIGINT overflow for player and game totals', async () => {
    const game = await seedGame('overflow', GameStatus.ACTIVE, 9223372036854775807n);
    await post(playerAuth, `/api/games/${game.id}/buyins`, {
      hands: 2,
      idempotencyKey: `${prefix}-overflow-buy`
    }).expect(409).expect(({ body }) => expect(body.code).toBe('BUYIN_AMOUNT_OVERFLOW'));
    await expect(prisma.gamePlayer.count({ where: { gameId: game.id } })).resolves.toBe(0);
    await expect(prisma.buyinEvent.count({ where: { gameId: game.id } })).resolves.toBe(0);
  });
});
