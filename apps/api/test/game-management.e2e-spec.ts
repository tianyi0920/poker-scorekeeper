import type { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { managedGamesResponseSchema } from '@poker/contracts';
import request, { type Response } from 'supertest';
import { vi } from 'vitest';
import {
  BuyinEventType,
  FeeType,
  GameStatus,
  Role,
  type Game,
  type User
} from '../src/generated/prisma/client.js';
import { GameManagementService } from '../src/games/game-management.service.js';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { requireAuthorizedTestDatabase } from './support/authorized-test-database.js';

requireAuthorizedTestDatabase();
const runId = randomUUID().replaceAll('-', '').slice(0, 8);
const prefix = `manage-${runId}`;
const password = `${randomBytes(18).toString('base64url')}Aa1!`;

interface AuthContext {
  cookie: string;
  csrfToken: string;
}

interface GameGraphFixture {
  gameId: string;
  gameName: string;
  playerIds: [string, string];
  settlementId: string;
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

function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe.sequential('super-administrator game management list', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let gameManagement: GameManagementService;
  let passwordHash: string;
  let superUser: User;
  let adminUser: User;
  let regularUser: User;
  let superAuth: AuthContext;
  let adminAuth: AuthContext;
  let userAuth: AuthContext;

  function gameId(suffix: string): string {
    return `gm-${runId}-${suffix}`;
  }

  async function seedUser(suffix: string, role: Role): Promise<User> {
    const username = `${prefix}-${suffix}`;
    const nickname = `管理-${runId}-${suffix}`;
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

  function read(auth: AuthContext | undefined, path: string) {
    const call = request(app.getHttpServer()).get(path);
    return auth === undefined ? call : call.set('Cookie', auth.cookie);
  }

  function write(auth: AuthContext | undefined, path: string) {
    let call = request(app.getHttpServer()).delete(path);
    if (auth !== undefined) {
      call = call
        .set('Cookie', auth.cookie)
        .set('X-CSRF-Token', auth.csrfToken);
    }
    return call;
  }

  async function seedGame(
    suffix: string,
    status: GameStatus,
    createdAt: Date,
    overrides: { id?: string; completedAt?: Date | null } = {}
  ) {
    return prisma.game.create({
      data: {
        id: overrides.id ?? gameId(suffix),
        name: `${prefix}-${suffix}`,
        status,
        handPrice: 300n,
        rakeEnabled: true,
        version: 1,
        createdById: superUser.id,
        createdAt,
        startedAt: status === GameStatus.DRAFT ? null : createdAt,
        stoppedAt: status === GameStatus.SETTLING ||
          status === GameStatus.COMPLETED ||
          status === GameStatus.VOIDED
          ? createdAt
          : null,
        completedAt: overrides.completedAt ?? (
          status === GameStatus.COMPLETED ? createdAt : null
        )
      }
    });
  }

  async function seedGameGraph(status: GameStatus): Promise<GameGraphFixture> {
    const suffix = `graph-${status.slice(0, 1).toLowerCase()}`;
    const id = gameId(suffix);
    const gameName = `${prefix}-delete-${status.toLowerCase()}`;
    const startedAt = new Date('2099-04-01T01:00:00.000Z');
    const stoppedAt = new Date('2099-04-01T02:00:00.000Z');
    await prisma.game.create({
      data: {
        id,
        name: gameName,
        status,
        handPrice: 300n,
        rakeEnabled: true,
        version: 4,
        createdById: superUser.id,
        startedAt: status === GameStatus.DRAFT ? null : startedAt,
        stoppedAt: status === GameStatus.DRAFT || status === GameStatus.ACTIVE
          ? null
          : stoppedAt,
        completedAt: status === GameStatus.COMPLETED ? stoppedAt : null,
        settledById: status === GameStatus.COMPLETED ? superUser.id : null,
        createdAt: new Date('2099-04-01T00:00:00.000Z')
      }
    });
    const playerIds: [string, string] = [`${id}-p1`, `${id}-p2`];
    const players = [adminUser, regularUser] as const;
    await prisma.gamePlayer.createMany({
      data: players.map((user, index) => ({
        id: playerIds[index]!,
        gameId: id,
        userId: user.id,
        nicknameSnapshot: `${user.nickname}-snapshot`,
        avatarKindSnapshot: user.avatarKind,
        avatarValueSnapshot: user.avatarValue,
        seatNo: index + 1,
        firstBuyinAt: startedAt
      }))
    });
    await prisma.activePlayerLock.createMany({
      data: players.map((user) => ({ gameId: id, userId: user.id }))
    });
    await prisma.buyinEvent.createMany({
      data: players.map((user, index) => {
        const eventId = `${id}-e${index + 1}`;
        return {
          id: eventId,
          gameId: id,
          gamePlayerId: playerIds[index]!,
          actorUserId: user.id,
          type: BuyinEventType.BUY,
          logicalBuyId: eventId,
          previousHands: null,
          newHands: 1,
          handsDelta: 1,
          gameVersion: index + 2,
          idempotencyKey: `${prefix}-${suffix}-buy-${index + 1}`
        };
      })
    });
    await prisma.settlementDraft.create({
      data: {
        id: `${id}-dr`,
        gameId: id,
        payload: {
          cashOutByPlayerId: { [playerIds[0]]: '600', [playerIds[1]]: '0' },
          roomFee: '10',
          roomPayerIds: [...playerIds],
          otherFee: '0',
          otherFeeNote: '',
          otherPayerIds: []
        },
        version: 1,
        editorUserId: superUser.id,
        updatedById: superUser.id,
        leaseExpiresAt: new Date('2099-04-01T03:00:00.000Z')
      }
    });
    const settlementId = `${id}-st`;
    await prisma.settlement.create({
      data: {
        id: settlementId,
        gameId: id,
        buyInTotal: 600n,
        cashOutTotal: 600n,
        roomFee: 10n,
        otherFee: 0n,
        otherFeeNote: '',
        rakeThresholdUsed: 1000n,
        rakeBpsUsed: 1000,
        settingsVersionUsed: 1,
        rakeTotal: 0n,
        finalTotal: -10n,
        settledById: superUser.id,
        settledByNicknameSnapshot: superUser.nickname,
        lockedAt: stoppedAt
      }
    });
    await prisma.settlementResult.createMany({
      data: [
        {
          id: `${id}-r1`, settlementId, gamePlayerId: playerIds[0],
          buyIn: 300n, cashOut: 600n, rawProfit: 300n,
          roomFeeShare: 5n, otherFeeShare: 0n, afterFeeProfit: 295n,
          rakeEligible: false, rakeAmount: 0n, finalAmount: 295n
        },
        {
          id: `${id}-r2`, settlementId, gamePlayerId: playerIds[1],
          buyIn: 300n, cashOut: 0n, rawProfit: -300n,
          roomFeeShare: 5n, otherFeeShare: 0n, afterFeeProfit: -305n,
          rakeEligible: false, rakeAmount: 0n, finalAmount: -305n
        }
      ]
    });
    await prisma.settlementFeeAllocation.createMany({
      data: playerIds.map((playerId, index) => ({
        id: `${id}-f${index + 1}`,
        settlementId,
        feeType: FeeType.ROOM,
        gamePlayerId: playerId,
        allocationOrder: index + 1,
        amount: 5n,
        receivedRemainder: false
      }))
    });
    await prisma.auditLog.create({
      data: {
        actorUserId: superUser.id,
        action: 'GAME_GRAPH_SEEDED',
        entityType: 'GAME',
        entityId: id,
        requestId: `${prefix}-${suffix}-seed`,
        beforeJson: { marker: 'must-survive-hard-delete' },
        sourceIp: 'test',
        userAgent: 'test'
      }
    });
    return { gameId: id, gameName, playerIds, settlementId };
  }

  async function expectGameGraphCounts(fixture: GameGraphFixture): Promise<void> {
    const counts = {
      games: await prisma.game.count({ where: { id: fixture.gameId } }),
      gamePlayers: await prisma.gamePlayer.count({ where: { gameId: fixture.gameId } }),
      buyinEvents: await prisma.buyinEvent.count({ where: { gameId: fixture.gameId } }),
      activePlayerLocks: await prisma.activePlayerLock.count({ where: { gameId: fixture.gameId } }),
      settlementDrafts: await prisma.settlementDraft.count({ where: { gameId: fixture.gameId } }),
      settlements: await prisma.settlement.count({ where: { gameId: fixture.gameId } }),
      settlementResults: await prisma.settlementResult.count({
        where: { settlementId: fixture.settlementId }
      }),
      settlementFeeAllocations: await prisma.settlementFeeAllocation.count({
        where: { settlementId: fixture.settlementId }
      })
    };
    expect(counts).toEqual({
      games: 0,
      gamePlayers: 0,
      buyinEvents: 0,
      activePlayerLocks: 0,
      settlementDrafts: 0,
      settlements: 0,
      settlementResults: 0,
      settlementFeeAllocations: 0
    });
  }

  async function cleanOwnedGames(): Promise<void> {
    const owned = await prisma.game.findMany({
      where: { id: { startsWith: `gm-${runId}-` } },
      select: { id: true }
    });
    const gameIds = owned.map(({ id }) => id);
    await prisma.auditLog.deleteMany({
      where: { entityType: 'GAME', entityId: { startsWith: `gm-${runId}-` } }
    });
    if (gameIds.length === 0) return;
    const settlementIds = (await prisma.settlement.findMany({
      where: { gameId: { in: gameIds } }, select: { id: true }
    })).map(({ id }) => id);
    if (settlementIds.length > 0) {
      await prisma.settlementFeeAllocation.deleteMany({
        where: { settlementId: { in: settlementIds } }
      });
      await prisma.settlementResult.deleteMany({ where: { settlementId: { in: settlementIds } } });
    }
    await prisma.settlement.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.settlementDraft.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.buyinEvent.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.activePlayerLock.deleteMany({ where: { gameId: { in: gameIds } } });
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
    gameManagement = app.get(GameManagementService);
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
    vi.restoreAllMocks();
    await cleanOwnedGames();
    superUser = await prisma.user.update({
      where: { id: superUser.id },
      data: { role: Role.SUPER_ADMIN, isActive: true, deletedAt: null }
    });
  });

  afterAll(async () => {
    if (prisma !== undefined) {
      await cleanOwnedGames();
      const ownedUsers = await prisma.user.findMany({
        where: { normalizedUsername: { startsWith: normalize(prefix) } },
        select: { id: true }
      });
      const userIds = ownedUsers.map(({ id }) => id);
      if (userIds.length > 0) {
        await prisma.authSession.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
    }
    if (app !== undefined) await app.close();
  }, 30_000);

  it.each([
    ['anonymous', undefined, 401, 'UNAUTHENTICATED'],
    ['user', () => userAuth, 403, 'FORBIDDEN'],
    ['admin', () => adminAuth, 403, 'FORBIDDEN']
  ] as const)('rejects %s from hard deletion', async (_label, auth, status, code) => {
    const game = await seedGame('delete-forbidden', GameStatus.DRAFT, new Date());
    await write(typeof auth === 'function' ? auth() : auth, `/api/games/${game.id}`)
      .expect(status)
      .expect(({ body }) => expect(body.code).toBe(code));
    await expect(prisma.game.count({ where: { id: game.id } })).resolves.toBe(1);
    await expect(prisma.auditLog.count({
      where: { action: 'GAME_HARD_DELETED', entityId: game.id }
    })).resolves.toBe(0);
  });

  it.each([
    GameStatus.DRAFT,
    GameStatus.ACTIVE,
    GameStatus.SETTLING,
    GameStatus.COMPLETED,
    GameStatus.VOIDED
  ])('hard deletes a %s game and all eight business-table rows', async (status) => {
    const fixture = await seedGameGraph(status);
    await write(superAuth, `/api/games/${fixture.gameId}`)
      .expect(200, { deletedGameId: fixture.gameId });

    await expectGameGraphCounts(fixture);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'GAME_HARD_DELETED', entityId: fixture.gameId }
    });
    expect(audit).toMatchObject({
      actorUserId: superUser.id,
      action: 'GAME_HARD_DELETED',
      entityType: 'GAME',
      entityId: fixture.gameId,
      afterJson: null
    });
    expect(audit.beforeJson).toEqual({
      id: fixture.gameId,
      name: fixture.gameName,
      status,
      deletedAt: expect.any(String)
    });
    expect(Object.keys(audit.beforeJson as object).sort())
      .toEqual(['deletedAt', 'id', 'name', 'status']);
    expect(new Date((audit.beforeJson as { deletedAt: string }).deletedAt).toISOString())
      .toBe((audit.beforeJson as { deletedAt: string }).deletedAt);
    await expect(prisma.auditLog.count({
      where: { action: 'GAME_HARD_DELETED', entityId: fixture.gameId }
    })).resolves.toBe(1);
    await expect(prisma.auditLog.count({
      where: { action: 'GAME_GRAPH_SEEDED', entityId: fixture.gameId }
    })).resolves.toBe(1);
  });

  it('returns exact success once, then NOT_FOUND without a second hard-delete audit', async () => {
    const game = await seedGame('empty', GameStatus.DRAFT, new Date());
    await write(superAuth, `/api/games/${game.id}`)
      .expect(200)
      .expect(({ body }) => expect(body).toEqual({ deletedGameId: game.id }));
    await write(superAuth, `/api/games/${game.id}`)
      .expect(404)
      .expect(({ body }) => expect(body.code).toBe('NOT_FOUND'));
    await expect(prisma.auditLog.count({
      where: { action: 'GAME_HARD_DELETED', entityId: game.id }
    })).resolves.toBe(1);
  });

  it.each([
    ['demoted', { role: Role.USER }],
    ['disabled', { isActive: false }],
    ['deleted', { deletedAt: new Date('2099-04-02T00:00:00.000Z') }]
  ] as const)('revalidates a session actor after it is %s in the database', async (_label, data) => {
    const fixture = await seedGameGraph(GameStatus.DRAFT);
    let serviceEntered!: () => void;
    const entered = new Promise<void>((resolve) => { serviceEntered = resolve; });
    const originalHardDelete = gameManagement.hardDelete.bind(gameManagement);
    vi.spyOn(gameManagement, 'hardDelete').mockImplementation(async (id, actor) => {
      serviceEntered();
      return originalHardDelete(id, actor);
    });
    let releaseCoordinator!: () => void;
    const release = new Promise<void>((resolve) => { releaseCoordinator = resolve; });
    const blocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM system_settings WHERE id = 'singleton' FOR UPDATE
      `;
      await release;
    }, { timeout: 10_000, maxWait: 5_000 });

    const deletion = write(superAuth, `/api/games/${fixture.gameId}`);
    const response = deletion.then((value) => value);
    await entered;
    await prisma.user.update({ where: { id: superUser.id }, data });
    releaseCoordinator();
    await blocker;

    try {
      await expect(response).resolves.toMatchObject({
        status: 403,
        body: { code: 'FORBIDDEN' }
      });
      await expect(prisma.game.count({ where: { id: fixture.gameId } })).resolves.toBe(1);
      await expect(prisma.auditLog.count({
        where: { action: 'GAME_HARD_DELETED', entityId: fixture.gameId }
      })).resolves.toBe(0);
    } finally {
      superUser = await prisma.user.update({
        where: { id: superUser.id },
        data: { role: Role.SUPER_ADMIN, isActive: true, deletedAt: null }
      });
    }
  });

  it.each([
    ['anonymous', undefined, 401, 'UNAUTHENTICATED'],
    ['user', () => userAuth, 403, 'FORBIDDEN'],
    ['admin', () => adminAuth, 403, 'FORBIDDEN']
  ] as const)('rejects %s from the management list', async (_label, auth, status, code) => {
    await read(typeof auth === 'function' ? auth() : auth, '/api/games/manage?limit=2')
      .expect(status)
      .expect(({ body }) => expect(body.code).toBe(code));
  });

  it('allows a super administrator and returns all five statuses with exact player counts', async () => {
    const statuses = [
      GameStatus.DRAFT,
      GameStatus.ACTIVE,
      GameStatus.SETTLING,
      GameStatus.COMPLETED,
      GameStatus.VOIDED
    ];
    const games: Game[] = [];
    for (const [index, status] of statuses.entries()) {
      games.push(await seedGame(
        `status-${index}`,
        status,
        new Date(`2099-01-01T00:00:0${index}.000Z`)
      ));
    }
    await prisma.gamePlayer.createMany({
      data: [superUser, adminUser, regularUser].map((user, index) => ({
        id: gameId(`player-${index}`),
        gameId: games[1]!.id,
        userId: user.id,
        nicknameSnapshot: user.nickname,
        avatarKindSnapshot: user.avatarKind,
        avatarValueSnapshot: user.avatarValue,
        seatNo: index + 1,
        firstBuyinAt: new Date('2099-01-01T00:01:00.000Z')
      }))
    });

    const response = await read(superAuth, '/api/games/manage').expect(200);
    expect(managedGamesResponseSchema.safeParse(response.body).success).toBe(true);
    const seededItems = response.body.items.filter(({ id }: { id: string }) =>
      games.some((game) => game.id === id)
    );
    expect(seededItems.map(({ status }: { status: GameStatus }) => status))
      .toEqual([...statuses].reverse());
    expect(seededItems.find(({ id }: { id: string }) => id === games[1]!.id).playerCount)
      .toBe(3);
    expect(seededItems.filter(({ id }: { id: string }) => id !== games[1]!.id))
      .toEqual(expect.arrayContaining(
        games.filter(({ id }) => id !== games[1]!.id).map(({ id }) =>
          expect.objectContaining({ id, playerCount: 0 })
        )
      ));
  });

  it('defaults to 50 items and rejects limits outside 1 through 50', async () => {
    await prisma.game.createMany({
      data: Array.from({ length: 51 }, (_, index) => ({
        id: gameId(`default-${String(index).padStart(2, '0')}`),
        name: `${prefix}-default-${index}`,
        status: GameStatus.DRAFT,
        handPrice: 300n,
        rakeEnabled: true,
        version: 1,
        createdById: superUser.id,
        createdAt: new Date('2099-02-01T00:00:00.000Z')
      }))
    });

    await read(superAuth, '/api/games/manage')
      .expect(200)
      .expect(({ body }) => {
        expect(body.items).toHaveLength(50);
        expect(body.nextCursor).toEqual(expect.any(String));
      });
    for (const limit of [0, 51]) {
      await read(superAuth, `/api/games/manage?limit=${limit}`)
        .expect(400)
        .expect(({ body }) => expect(body.code).toBe('VALIDATION_ERROR'));
    }
  });

  it.each([
    ['invalid base64url', 'not+a+base64url'],
    ['non-JSON payload', Buffer.from('not-json').toString('base64url')],
    ['invalid timestamp', encodeCursor({ createdAt: 'yesterday', id: 'game-1' })],
    ['non-canonical public id', encodeCursor({ createdAt: '2099-01-01T00:00:00.000Z', id: 'GAME-1' })],
    ['unknown cursor field', encodeCursor({
      createdAt: '2099-01-01T00:00:00.000Z', id: 'game-1', offset: 2
    })]
  ])('rejects a malformed cursor with VALIDATION_ERROR: %s', async (_label, cursor) => {
    await read(superAuth, `/api/games/manage?cursor=${encodeURIComponent(cursor)}`)
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('VALIDATION_ERROR'));
  });

  it('uses descending public IDs to break equal-createdAt ties without duplicates or omissions', async () => {
    const createdAt = new Date('2099-03-01T00:00:00.000Z');
    const expectedIds = ['g', 'f', 'e', 'd', 'c', 'b', 'a'].map((suffix) =>
      gameId(`tie-${suffix}`)
    );
    for (const id of [...expectedIds].reverse()) {
      await seedGame(id.slice(`gm-${runId}-`.length), GameStatus.DRAFT, createdAt, { id });
    }
    const externalId = gameId('tie-dd');
    await prisma.game.create({
      data: {
        id: externalId,
        name: `${prefix}-external-tie`,
        status: GameStatus.DRAFT,
        handPrice: 300n,
        rakeEnabled: true,
        version: 1,
        createdById: adminUser.id,
        createdAt
      }
    });

    try {
      const expectedIdSet = new Set(expectedIds);
      const targetOrder: string[] = [];
      const targetCounts = new Map<string, number>();
      const visitedCursors = new Set<string>();
      const pageSize = 3;
      const maxPages = Math.ceil((await prisma.game.count()) / pageSize) + 2;
      let cursor: string | undefined;
      let reachedFinalPage = false;

      for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
        const path = cursor === undefined
          ? `/api/games/manage?limit=${pageSize}`
          : `/api/games/manage?limit=${pageSize}&cursor=${encodeURIComponent(cursor)}`;
        const response = await read(superAuth, path).expect(200);
        for (const item of response.body.items as Array<{ id: string }>) {
          if (!expectedIdSet.has(item.id)) continue;
          targetOrder.push(item.id);
          targetCounts.set(item.id, (targetCounts.get(item.id) ?? 0) + 1);
        }

        if (response.body.nextCursor === null) {
          reachedFinalPage = true;
          break;
        }
        if (typeof response.body.nextCursor !== 'string') {
          throw new Error('Management pagination returned neither a cursor nor null');
        }
        expect(visitedCursors.has(response.body.nextCursor)).toBe(false);
        visitedCursors.add(response.body.nextCursor);
        cursor = response.body.nextCursor;
      }

      expect(reachedFinalPage).toBe(true);
      expect(targetOrder).toEqual(expectedIds);
      expect(expectedIds.map((id) => targetCounts.get(id) ?? 0))
        .toEqual(expectedIds.map(() => 1));
    } finally {
      const cleaned = await prisma.game.deleteMany({ where: { id: externalId } });
      expect(cleaned.count).toBe(1);
    }
  });
});
