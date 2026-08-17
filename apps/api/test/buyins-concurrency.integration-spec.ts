import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { BuyinsService } from '../src/buyins/buyins.service.js';
import { GameStatus, Role, type Game, type User } from '../src/generated/prisma/client.js';
import { GamesService } from '../src/games/games.service.js';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const databaseName = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
if (!databaseName.endsWith('_test')) {
  throw new Error(`Buy-in concurrency tests require an isolated *_test database, got ${databaseName || '(none)'}`);
}

const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const prefix = `buyin-race-${runId}`;

function normalize(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function authUser(user: User): AuthUser {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    role: user.role,
    mustChangePassword: user.mustChangePassword
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe.sequential('buy-in transaction concurrency', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let buyins: BuyinsService;
  let games: GamesService;
  let admin: User;
  let player: User;
  let secondPlayer: User;

  async function seedUser(suffix: string, role: Role = Role.USER): Promise<User> {
    const username = `${prefix}-${suffix}`;
    const nickname = `并发买入-${runId}-${suffix}`;
    return prisma.user.create({
      data: {
        username,
        normalizedUsername: normalize(username),
        nickname,
        activeNormalizedNickname: normalize(nickname),
        passwordHash: 'not-used-by-service-integration-tests',
        role,
        avatarValue: 'preset-02'
      }
    });
  }

  async function seedGame(suffix: string): Promise<Game> {
    return prisma.game.create({
      data: {
        name: `${prefix}-${suffix}`,
        handPrice: 300n,
        rakeEnabled: true,
        status: GameStatus.ACTIVE,
        version: 1,
        createdById: admin.id,
        startedAt: new Date()
      }
    });
  }

  async function cleanGames(): Promise<void> {
    const owned = await prisma.game.findMany({
      where: { name: { startsWith: prefix } },
      select: { id: true }
    });
    const gameIds = owned.map(({ id }) => id);
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
    process.env.BOOTSTRAP_ADMIN_USERNAME = `${prefix}-bootstrap`;
    process.env.BOOTSTRAP_ADMIN_NICKNAME = `并发买入根-${runId}`;
    process.env.BOOTSTRAP_ADMIN_PASSWORD = `${randomUUID()}Aa1!`;
    app = await createApp();
    prisma = app.get(PrismaService);
    buyins = app.get(BuyinsService);
    games = app.get(GamesService);
    await app.init();
    admin = await seedUser('admin', Role.ADMIN);
    player = await seedUser('player');
    secondPlayer = await seedUser('second-player');
  }, 30_000);

  beforeEach(async () => {
    await cleanGames();
    player = await prisma.user.update({
      where: { id: player.id },
      data: { isActive: true, deletedAt: null }
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

  it('commits one event for two simultaneous identical idempotent requests', async () => {
    const game = await seedGame('same-key');
    const key = `${prefix}-same-key`;
    const results = await Promise.all([
      buyins.buy(game.id, authUser(player), { hands: 5, idempotencyKey: key }),
      buyins.buy(game.id, authUser(player), { hands: 5, idempotencyKey: key })
    ]);

    expect(new Set(results.map(({ eventId }) => eventId)).size).toBe(1);
    expect(results.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    await expect(prisma.buyinEvent.count({ where: { idempotencyKey: key } })).resolves.toBe(1);
    await expect(prisma.auditLog.count({
      where: { action: 'BUYIN_BOUGHT', entityId: results[0]!.eventId }
    })).resolves.toBe(1);
    await expect(prisma.game.findUniqueOrThrow({ where: { id: game.id } }))
      .resolves.toMatchObject({ version: 2 });
  });

  it.each([
    ['uppercase idempotency key', (game: Game) => buyins.buy(game.id, authUser(player), {
      hands: 1,
      idempotencyKey: `${prefix}-UPPER`
    })],
    ['space-suffixed idempotency key', (game: Game) => buyins.buy(game.id, authUser(player), {
      hands: 1,
      idempotencyKey: `${prefix}-space `
    })],
    ['uppercase game id', (game: Game) => buyins.buy(game.id.toUpperCase(), authUser(player), {
      hands: 1,
      idempotencyKey: `${prefix}-invalid-game`
    })]
  ] as const)('defensively rejects %s when the service is called directly', async (_label, call) => {
    const game = await seedGame(`service-validation-${_label}`);
    const transactionSpy = vi.spyOn(prisma, '$transaction');
    try {
      await expect(call(game)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(transactionSpy).not.toHaveBeenCalled();
      await expect(prisma.activePlayerLock.findUnique({ where: { userId: player.id } }))
        .resolves.toBeNull();
      await expect(prisma.gamePlayer.count({ where: { gameId: game.id } })).resolves.toBe(0);
      await expect(prisma.buyinEvent.count({ where: { gameId: game.id } })).resolves.toBe(0);
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it('defensively rejects a non-canonical player id before starting a transaction', async () => {
    const game = await seedGame('service-player-validation');
    const bought = await buyins.buy(game.id, authUser(player), {
      hands: 2,
      idempotencyKey: `${prefix}-service-player-seed`
    });
    const transactionSpy = vi.spyOn(prisma, '$transaction');
    try {
      await expect(buyins.adjust(game.id, bought.playerId.toUpperCase(), authUser(player), {
        newHands: 1,
        idempotencyKey: `${prefix}-service-player-invalid`
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(transactionSpy).not.toHaveBeenCalled();
      await expect(prisma.buyinEvent.count({ where: { gameId: game.id } })).resolves.toBe(1);
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it('returns one stable conflict for simultaneous different payloads sharing a key', async () => {
    const game = await seedGame('key-conflict');
    const key = `${prefix}-conflicting-key`;
    const outcomes = await Promise.allSettled([
      buyins.buy(game.id, authUser(player), { hands: 1, idempotencyKey: key }),
      buyins.buy(game.id, authUser(player), { hands: 2, idempotencyKey: key })
    ]);

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(({ status }) => status === 'rejected'))
      .toMatchObject({ status: 'rejected', reason: { code: 'BUYIN_IDEMPOTENCY_CONFLICT' } });
    const stored = await prisma.buyinEvent.findUniqueOrThrow({ where: { idempotencyKey: key } });
    expect([1, 2]).toContain(stored.newHands);
    await expect(prisma.buyinEvent.count({ where: { idempotencyKey: key } })).resolves.toBe(1);
  });

  it('allows only one simultaneous first buy by one user in different games', async () => {
    const gameA = await seedGame('one-user-a');
    const gameB = await seedGame('one-user-b');
    const outcomes = await Promise.allSettled([
      buyins.buy(gameA.id, authUser(player), { hands: 1, idempotencyKey: `${prefix}-game-a` }),
      buyins.buy(gameB.id, authUser(player), { hands: 1, idempotencyKey: `${prefix}-game-b` })
    ]);

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(({ status }) => status === 'rejected'))
      .toMatchObject({ status: 'rejected', reason: { code: 'USER_IN_ACTIVE_GAME' } });
    const lock = await prisma.activePlayerLock.findUniqueOrThrow({ where: { userId: player.id } });
    await expect(prisma.gamePlayer.count({ where: { userId: player.id } })).resolves.toBe(1);
    await expect(prisma.buyinEvent.count({ where: { actorUserId: player.id } })).resolves.toBe(1);
    expect([gameA.id, gameB.id]).toContain(lock.gameId);
    const losingGameId = lock.gameId === gameA.id ? gameB.id : gameA.id;
    await expect(prisma.gamePlayer.count({
      where: { gameId: losingGameId, userId: player.id }
    })).resolves.toBe(0);
    await expect(prisma.buyinEvent.count({ where: { gameId: losingGameId } })).resolves.toBe(0);
  });

  it('serializes buy and begin-settlement without a post-stop purchase', async () => {
    const game = await seedGame('settlement-race');
    const [buy, settlement] = await Promise.allSettled([
      buyins.buy(game.id, authUser(player), {
        hands: 1,
        idempotencyKey: `${prefix}-settlement-race-buy`
      }),
      games.beginSettlement(game.id, authUser(admin))
    ]);

    expect(settlement.status).toBe('fulfilled');
    const stored = await prisma.game.findUniqueOrThrow({ where: { id: game.id } });
    expect(stored.status).toBe(GameStatus.SETTLING);
    const eventCount = await prisma.buyinEvent.count({ where: { gameId: game.id } });
    if (buy.status === 'fulfilled') {
      expect(eventCount).toBe(1);
      expect(stored.version).toBe(3);
    } else {
      expect(buy.reason).toMatchObject({ code: 'GAME_STATE_CONFLICT' });
      expect(eventCount).toBe(0);
      expect(stored.version).toBe(2);
    }
    await expect(prisma.auditLog.count({
      where: { action: 'BUYIN_BOUGHT', entityId: { in: (await prisma.buyinEvent.findMany({
        where: { gameId: game.id },
        select: { id: true }
      })).map(({ id }) => id) } }
    })).resolves.toBe(eventCount);
  });

  it('re-reads active and deleted user state after waiting on the user lock', async () => {
    const game = await seedGame('user-reread');
    let userLocked!: () => void;
    let releaseUser!: () => void;
    const locked = new Promise<void>((resolve) => { userLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseUser = resolve; });
    const blocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM users WHERE id = ${player.id} FOR UPDATE
      `;
      userLocked();
      await release;
      await transaction.user.update({
        where: { id: player.id },
        data: { isActive: false }
      });
    }, { timeout: 10_000, maxWait: 5_000 });
    await locked;

    let settled = false;
    const buying = buyins.buy(game.id, authUser(player), {
      hands: 1,
      idempotencyKey: `${prefix}-stale-actor`
    }).finally(() => { settled = true; });
    await delay(200);
    expect(settled).toBe(false);
    releaseUser();
    await blocker;

    await expect(buying).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(prisma.gamePlayer.count({ where: { gameId: game.id } })).resolves.toBe(0);
    await expect(prisma.buyinEvent.count({ where: { gameId: game.id } })).resolves.toBe(0);
    await expect(prisma.activePlayerLock.findUnique({ where: { userId: player.id } })).resolves.toBeNull();
  }, 15_000);

  it('never adjusts an older logical buy when a correction races a new purchase', async () => {
    const game = await seedGame('adjust-race');
    const first = await buyins.buy(game.id, authUser(player), {
      hands: 5,
      idempotencyKey: `${prefix}-adjust-race-first`
    });
    const outcomes = await Promise.allSettled([
      buyins.buy(game.id, authUser(player), {
        hands: 2,
        idempotencyKey: `${prefix}-adjust-race-second`
      }),
      buyins.adjust(game.id, first.playerId, authUser(player), {
        newHands: 3,
        idempotencyKey: `${prefix}-adjust-race-adjust`
      })
    ]);
    expect(outcomes.every(({ status }) => status === 'fulfilled')).toBe(true);

    const events = await prisma.buyinEvent.findMany({
      where: { gameId: game.id, gamePlayerId: first.playerId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    });
    let latestLogicalBuyId: string | undefined;
    for (const event of events) {
      if (event.type === 'BUY') latestLogicalBuyId = event.logicalBuyId;
      else expect(event.logicalBuyId).toBe(latestLogicalBuyId);
    }
    expect(events.filter(({ type }) => type === 'BUY')).toHaveLength(2);
    expect(events.filter(({ type }) => type === 'ADJUST')).toHaveLength(1);
  });

  it('exposes deterministic effective buys and an exact bigint player amount', async () => {
    const game = await seedGame('effective-read');
    const first = await buyins.buy(game.id, authUser(secondPlayer), {
      hands: 2,
      idempotencyKey: `${prefix}-effective-first`
    });
    const second = await buyins.buy(game.id, authUser(secondPlayer), {
      hands: 5,
      idempotencyKey: `${prefix}-effective-second`
    });
    await buyins.adjust(game.id, second.playerId, authUser(secondPlayer), {
      newHands: 3,
      idempotencyKey: `${prefix}-effective-adjust`
    });

    await expect(buyins.getEffectiveBuyins(game.id)).resolves.toEqual([
      { gamePlayerId: first.playerId, logicalBuyId: first.logicalBuyId, effectiveHands: 2 },
      { gamePlayerId: second.playerId, logicalBuyId: second.logicalBuyId, effectiveHands: 3 }
    ]);
    await expect(buyins.getPlayerBuyInTotal(first.playerId)).resolves.toBe(1500n);
  });
});
