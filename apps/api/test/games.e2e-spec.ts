import type { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import request, { type Response } from 'supertest';
import { BuyinEventType, GameStatus, Role, type User } from '../src/generated/prisma/client.js';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const runId = randomUUID().replaceAll('-', '').slice(0, 10);
const prefix = `games-${runId}`;
const password = `${randomBytes(18).toString('base64url')}Aa1!`;

interface AuthContext {
  cookie: string;
  csrfToken: string;
}

function normalize(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}

function cookieFrom(response: Response): string {
  const header = response.headers['set-cookie'];
  const serialized = Array.isArray(header) ? header[0] : header;
  expect(serialized).toBeDefined();
  return serialized!.split(';', 1)[0]!;
}

describe.sequential('game lifecycle and snapshots', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let passwordHash: string;
  let superUser: User;
  let adminUser: User;
  let regularUser: User;
  let superAuth: AuthContext;
  let adminAuth: AuthContext;
  let userAuth: AuthContext;

  async function seedUser(suffix: string, role: Role): Promise<User> {
    const username = `${prefix}-${suffix}`;
    const nickname = `牌局-${runId}-${suffix}`;
    return prisma.user.create({
      data: {
        username,
        normalizedUsername: normalize(username),
        nickname,
        activeNormalizedNickname: normalize(nickname),
        passwordHash,
        role,
        avatarValue: 'preset-01'
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

  function write(
    auth: AuthContext,
    method: 'post' | 'delete',
    path: string,
    body?: object
  ) {
    let call = request(app.getHttpServer())[method](path)
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrfToken);
    if (body !== undefined) call = call.send(body);
    return call;
  }

  function get(auth: AuthContext, path: string) {
    return request(app.getHttpServer()).get(path).set('Cookie', auth.cookie);
  }

  async function seedGame(
    name: string,
    status: GameStatus,
    overrides: { handPrice?: bigint; startedAt?: Date; stoppedAt?: Date } = {}
  ) {
    return prisma.game.create({
      data: {
        name,
        status,
        handPrice: overrides.handPrice ?? 300n,
        rakeEnabled: true,
        version: 1,
        createdById: adminUser.id,
        startedAt: overrides.startedAt ?? (status === GameStatus.DRAFT ? null : new Date()),
        stoppedAt: overrides.stoppedAt ?? null
      }
    });
  }

  async function ownedGameIds(): Promise<string[]> {
    return (await prisma.game.findMany({
      where: { createdById: { in: [superUser.id, adminUser.id] } },
      select: { id: true }
    })).map(({ id }) => id);
  }

  async function cleanOwnedGames(): Promise<void> {
    const gameIds = await ownedGameIds();
    if (gameIds.length === 0) return;
    const players = await prisma.gamePlayer.findMany({
      where: { gameId: { in: gameIds } },
      select: { id: true }
    });
    const playerIds = players.map(({ id }) => id);
    await prisma.auditLog.deleteMany({
      where: { entityType: 'GAME', entityId: { in: gameIds } }
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
    process.env.BOOTSTRAP_ADMIN_NICKNAME = `根-${runId}`;
    process.env.BOOTSTRAP_ADMIN_PASSWORD = password;

    app = await createApp();
    prisma = app.get(PrismaService);
    await app.init();
    passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    superUser = await seedUser('super', Role.SUPER_ADMIN);
    adminUser = await seedUser('admin', Role.ADMIN);
    regularUser = await seedUser('user', Role.USER);
    superAuth = await login(superUser);
    adminAuth = await login(adminUser);
    userAuth = await login(regularUser);
  }, 30_000);

  beforeEach(async () => {
    await cleanOwnedGames();
  });

  afterAll(async () => {
    if (prisma !== undefined) {
      await cleanOwnedGames();
      const owned = await prisma.user.findMany({
        where: { normalizedUsername: { startsWith: normalize(prefix) } },
        select: { id: true }
      });
      const ids = owned.map(({ id }) => id);
      if (ids.length > 0) {
        await prisma.auditLog.deleteMany({ where: { actorUserId: { in: ids } } });
        await prisma.authSession.deleteMany({ where: { userId: { in: ids } } });
        await prisma.user.deleteMany({ where: { id: { in: ids } } });
      }
    }
    if (app !== undefined) await app.close();
  }, 30_000);

  it('requires login to list current games', async () => {
    await request(app.getHttpServer())
      .get('/api/games/current')
      .expect(401)
      .expect(({ body }) => expect(body.code).toBe('UNAUTHENTICATED'));
  });

  it('uses defaults and generates an editable Shanghai session name', async () => {
    const generated = await write(adminAuth, 'post', '/api/games', {})
      .expect(201);
    expect(generated.body).toMatchObject({
      status: 'DRAFT',
      version: 1,
      handPrice: '300',
      rakeEnabled: true,
      players: [],
      purchases: [],
      spectators: []
    });
    expect(generated.body.name).toMatch(/^\d{1,2}月\d{1,2}日(?:早场|午场|晚场)$/);

    const edited = await write(superAuth, 'post', '/api/games', {
      name: '  中文自定义场  ',
      handPrice: '500',
      rakeEnabled: false
    }).expect(201);
    expect(edited.body).toMatchObject({
      name: '中文自定义场',
      handPrice: '500',
      rakeEnabled: false
    });
  });

  it.each([
    ['normal user', () => write(userAuth, 'post', '/api/games', {}), 403, 'FORBIDDEN'],
    ['zero hand price', () => write(adminAuth, 'post', '/api/games', { handPrice: '0' }), 400, 'VALIDATION_ERROR'],
    ['negative hand price', () => write(adminAuth, 'post', '/api/games', { handPrice: '-1' }), 400, 'VALIDATION_ERROR'],
    ['non-canonical hand price', () => write(adminAuth, 'post', '/api/games', { handPrice: '0300' }), 400, 'VALIDATION_ERROR'],
    ['numeric hand price', () => write(adminAuth, 'post', '/api/games', { handPrice: 300 }), 400, 'VALIDATION_ERROR'],
    ['out-of-range hand price', () => write(adminAuth, 'post', '/api/games', { handPrice: '9223372036854775808' }), 400, 'VALIDATION_ERROR'],
    ['blank name', () => write(adminAuth, 'post', '/api/games', { name: '   ' }), 400, 'VALIDATION_ERROR'],
    ['control character name', () => write(adminAuth, 'post', '/api/games', { name: '坏\n名字' }), 400, 'VALIDATION_ERROR']
  ] as const)('rejects %s create', async (_label, action, status, code) => {
    await action()
      .expect(status)
      .expect(({ body }) => expect(body.code).toBe(code));
  });

  it('allows only two ACTIVE or SETTLING games', async () => {
    const first = await seedGame(`${prefix}-open-1`, GameStatus.ACTIVE);
    await seedGame(`${prefix}-settling`, GameStatus.SETTLING, { stoppedAt: new Date() });
    const third = await seedGame(`${prefix}-third`, GameStatus.DRAFT);

    await write(adminAuth, 'post', `/api/games/${third.id}/start`)
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('ACTIVE_GAME_LIMIT'));
    expect((await prisma.game.findUniqueOrThrow({ where: { id: third.id } })).status)
      .toBe(GameStatus.DRAFT);
    expect((await prisma.game.findUniqueOrThrow({ where: { id: first.id } })).status)
      .toBe(GameStatus.ACTIVE);
  });

  it('rejects a duplicate normalized name among ACTIVE and SETTLING games', async () => {
    await seedGame('周末 大场', GameStatus.ACTIVE);
    const duplicate = await seedGame('周末 大场', GameStatus.DRAFT);

    await write(adminAuth, 'post', `/api/games/${duplicate.id}/start`)
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('ACTIVE_GAME_NAME_TAKEN'));
    expect((await prisma.game.findUniqueOrThrow({ where: { id: duplicate.id } })).status)
      .toBe(GameStatus.DRAFT);
  });

  it('starts a draft with timestamps, versioning, and a transactional audit', async () => {
    const draft = await seedGame(`${prefix}-start`, GameStatus.DRAFT);

    const response = await write(adminAuth, 'post', `/api/games/${draft.id}/start`)
      .expect(200);
    expect(response.body).toMatchObject({ id: draft.id, status: 'ACTIVE', version: 2 });
    expect(response.body.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await prisma.auditLog.findFirst({
      where: { action: 'GAME_STARTED', entityType: 'GAME', entityId: draft.id }
    })).toMatchObject({ actorUserId: adminUser.id });
  });

  it('moves an ACTIVE game to SETTLING and records stoppedAt', async () => {
    const active = await seedGame(`${prefix}-settle`, GameStatus.ACTIVE);

    const response = await write(superAuth, 'post', `/api/games/${active.id}/begin-settlement`)
      .expect(200);
    expect(response.body).toMatchObject({ status: 'SETTLING', version: 2 });
    expect(response.body.stoppedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await prisma.auditLog.count({
      where: { action: 'GAME_SETTLEMENT_BEGUN', entityId: active.id }
    })).toBe(1);
  });

  it('deletes only an unrelated DRAFT and audits the deletion', async () => {
    const draft = await seedGame(`${prefix}-delete`, GameStatus.DRAFT);

    await write(adminAuth, 'delete', `/api/games/${draft.id}/draft`).expect(204);
    expect(await prisma.game.findUnique({ where: { id: draft.id } })).toBeNull();
    expect(await prisma.auditLog.count({
      where: { action: 'GAME_DRAFT_DELETED', entityId: draft.id }
    })).toBe(1);
  });

  it('refuses to delete a DRAFT with related rows', async () => {
    const draft = await seedGame(`${prefix}-related-draft`, GameStatus.DRAFT);
    await prisma.gamePlayer.create({
      data: {
        gameId: draft.id,
        userId: regularUser.id,
        nicknameSnapshot: regularUser.nickname,
        avatarKindSnapshot: regularUser.avatarKind,
        avatarValueSnapshot: regularUser.avatarValue,
        seatNo: 1,
        firstBuyinAt: new Date()
      }
    });

    await write(adminAuth, 'delete', `/api/games/${draft.id}/draft`)
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('GAME_HAS_RELATIONS'));
    expect(await prisma.game.findUnique({ where: { id: draft.id } })).not.toBeNull();
  });

  it('voids an ACTIVE game with no purchases', async () => {
    const active = await seedGame(`${prefix}-void`, GameStatus.ACTIVE);

    const response = await write(adminAuth, 'post', `/api/games/${active.id}/void`)
      .expect(200);
    expect(response.body).toMatchObject({ status: 'VOIDED', version: 2 });
    expect(response.body.stoppedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('refuses to void an ACTIVE game with a purchase', async () => {
    const active = await seedGame(`${prefix}-purchased`, GameStatus.ACTIVE);
    const player = await prisma.gamePlayer.create({
      data: {
        gameId: active.id,
        userId: regularUser.id,
        nicknameSnapshot: regularUser.nickname,
        avatarKindSnapshot: regularUser.avatarKind,
        avatarValueSnapshot: regularUser.avatarValue,
        seatNo: 1,
        firstBuyinAt: new Date()
      }
    });
    await prisma.buyinEvent.create({
      data: {
        gameId: active.id,
        gamePlayerId: player.id,
        actorUserId: regularUser.id,
        type: BuyinEventType.BUY,
        logicalBuyId: `${prefix}-logical`,
        previousHands: null,
        newHands: 1,
        handsDelta: 1,
        idempotencyKey: `${prefix}-purchase`
      }
    });

    await write(adminAuth, 'post', `/api/games/${active.id}/void`)
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('GAME_HAS_BUYINS'));
    expect((await prisma.game.findUniqueOrThrow({ where: { id: active.id } })).status)
      .toBe(GameStatus.ACTIVE);
  });

  it.each([
    ['start ACTIVE', GameStatus.ACTIVE, 'start'],
    ['begin-settlement DRAFT', GameStatus.DRAFT, 'begin-settlement'],
    ['void SETTLING', GameStatus.SETTLING, 'void']
  ] as const)('rejects invalid transition: %s', async (_label, status, action) => {
    const game = await seedGame(`${prefix}-${status}-${action}`, status);
    await write(adminAuth, 'post', `/api/games/${game.id}/${action}`)
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('GAME_STATE_CONFLICT'));
  });

  it('enforces snapshot visibility for drafts and historical games', async () => {
    const draft = await seedGame(`${prefix}-private-draft`, GameStatus.DRAFT);
    const completed = await seedGame(`${prefix}-unplayed-completed`, GameStatus.COMPLETED, {
      stoppedAt: new Date()
    });
    const voided = await seedGame(`${prefix}-unplayed-voided`, GameStatus.VOIDED, {
      stoppedAt: new Date()
    });
    const participated = await seedGame(`${prefix}-played-completed`, GameStatus.COMPLETED, {
      stoppedAt: new Date()
    });
    await prisma.gamePlayer.create({
      data: {
        gameId: participated.id,
        userId: regularUser.id,
        nicknameSnapshot: regularUser.nickname,
        avatarKindSnapshot: regularUser.avatarKind,
        avatarValueSnapshot: regularUser.avatarValue,
        seatNo: 1,
        firstBuyinAt: new Date()
      }
    });

    for (const game of [draft, completed, voided]) {
      await get(userAuth, `/api/games/${game.id}/snapshot`)
        .expect(403)
        .expect(({ body }) => expect(body.code).toBe('FORBIDDEN'));
    }
    await get(userAuth, `/api/games/${participated.id}/snapshot`)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        id: participated.id,
        status: GameStatus.COMPLETED,
        players: [{ userId: regularUser.id }]
      }));

    for (const auth of [adminAuth, superAuth]) {
      for (const game of [draft, completed, voided, participated]) {
        await get(auth, `/api/games/${game.id}/snapshot`).expect(200);
      }
    }
    await get(userAuth, `/api/games/missing-${runId}/snapshot`)
      .expect(404)
      .expect(({ body }) => expect(body.code).toBe('NOT_FOUND'));
  });

  it('lets every logged-in role see current games and a full-table snapshot', async () => {
    const startedAt = new Date('2026-08-17T10:00:00.000Z');
    const game = await seedGame(`${prefix}-snapshot`, GameStatus.ACTIVE, {
      handPrice: 300n,
      startedAt
    });
    const actor = await seedUser('buyer-actor', Role.USER);
    const actorPlayer = await prisma.gamePlayer.create({
      data: {
        gameId: game.id,
        userId: actor.id,
        nicknameSnapshot: actor.nickname,
        avatarKindSnapshot: actor.avatarKind,
        avatarValueSnapshot: actor.avatarValue,
        seatNo: 2,
        firstBuyinAt: new Date('2026-08-17T10:01:00.000Z')
      }
    });
    const regularPlayer = await prisma.gamePlayer.create({
      data: {
        gameId: game.id,
        userId: regularUser.id,
        nicknameSnapshot: regularUser.nickname,
        avatarKindSnapshot: regularUser.avatarKind,
        avatarValueSnapshot: regularUser.avatarValue,
        seatNo: 1,
        firstBuyinAt: new Date('2026-08-17T10:02:00.000Z')
      }
    });
    await prisma.buyinEvent.createMany({
      data: [
        {
          id: `${prefix}-buy-2`,
          gameId: game.id,
          gamePlayerId: actorPlayer.id,
          actorUserId: actor.id,
          type: BuyinEventType.BUY,
          logicalBuyId: `${prefix}-logical-2`,
          previousHands: null,
          newHands: 2,
          handsDelta: 2,
          idempotencyKey: `${prefix}-idem-2`,
          createdAt: new Date('2026-08-17T10:03:00.000Z')
        },
        {
          id: `${prefix}-buy-1`,
          gameId: game.id,
          gamePlayerId: regularPlayer.id,
          actorUserId: actor.id,
          type: BuyinEventType.BUY,
          logicalBuyId: `${prefix}-logical-1`,
          previousHands: null,
          newHands: 5,
          handsDelta: 5,
          idempotencyKey: `${prefix}-idem-1`,
          createdAt: new Date('2026-08-17T10:04:00.000Z')
        },
        {
          id: `${prefix}-adjust-1`,
          gameId: game.id,
          gamePlayerId: regularPlayer.id,
          actorUserId: adminUser.id,
          type: BuyinEventType.ADJUST,
          logicalBuyId: `${prefix}-logical-1`,
          previousHands: 5,
          newHands: 3,
          handsDelta: -2,
          idempotencyKey: `${prefix}-idem-adjust`,
          createdAt: new Date('2026-08-17T10:05:00.000Z')
        }
      ]
    });

    for (const auth of [userAuth, adminAuth, superAuth]) {
      const current = await get(auth, '/api/games/current').expect(200);
      expect(current.body.games.map(({ id }: { id: string }) => id)).toContain(game.id);
      const snapshot = await get(auth, `/api/games/${game.id}/snapshot`).expect(200);
      expect(snapshot.body).toMatchObject({
        id: game.id,
        status: 'ACTIVE',
        handPrice: '300',
        startedAt: startedAt.toISOString(),
        players: [
          {
            id: regularPlayer.id,
            userId: regularUser.id,
            nickname: regularUser.nickname,
            avatarUrl: '/avatars/preset-01.webp',
            seatNo: 1,
            effectiveHands: 3,
            buyInAmount: '900'
          },
          {
            id: actorPlayer.id,
            userId: actor.id,
            nickname: actor.nickname,
            avatarUrl: '/avatars/preset-01.webp',
            seatNo: 2,
            effectiveHands: 2,
            buyInAmount: '600'
          }
        ],
        purchases: [
          { id: `${prefix}-buy-2`, playerId: actorPlayer.id, actorNickname: actor.nickname },
          { id: `${prefix}-buy-1`, playerId: regularPlayer.id, actorNickname: actor.nickname },
          { id: `${prefix}-adjust-1`, playerId: regularPlayer.id, actorNickname: adminUser.nickname }
        ],
        spectators: []
      });
      expect(snapshot.body.serverNow).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});
