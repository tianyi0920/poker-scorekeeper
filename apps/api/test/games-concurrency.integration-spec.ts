import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { GameStatus, Role, type Game, type User } from '../src/generated/prisma/client.js';
import { lockGameForUpdate } from '../src/games/game-lock.js';
import { GamesService } from '../src/games/games.service.js';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const databaseName = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
if (!databaseName.endsWith('_test')) {
  throw new Error(`Game concurrency tests require an isolated *_test database, got ${databaseName || '(none)'}`);
}

const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const prefix = `game-race-${runId}`;

function normalize(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

describe.sequential('game lifecycle concurrency', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let games: GamesService;
  let actor: User;

  async function seedGame(name: string, status: GameStatus = GameStatus.DRAFT): Promise<Game> {
    return prisma.game.create({
      data: {
        name: `${prefix}-${name}`,
        handPrice: 300n,
        rakeEnabled: true,
        status,
        version: 1,
        createdById: actor.id,
        startedAt: status === GameStatus.DRAFT ? null : new Date()
      }
    });
  }

  async function cleanGames(): Promise<void> {
    const ownedGames = await prisma.game.findMany({
      where: { name: { startsWith: prefix } },
      select: { id: true }
    });
    const gameIds = ownedGames.map(({ id }) => id);
    if (gameIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { entityType: 'GAME', entityId: { in: gameIds } } });
      await prisma.buyinEvent.deleteMany({ where: { gameId: { in: gameIds } } });
      await prisma.activePlayerLock.deleteMany({ where: { gameId: { in: gameIds } } });
      await prisma.gamePlayer.deleteMany({ where: { gameId: { in: gameIds } } });
      await prisma.game.deleteMany({ where: { id: { in: gameIds } } });
    }
  }

  async function cleanRun(): Promise<void> {
    await cleanGames();
    const ownedUsers = await prisma.user.findMany({
      where: { normalizedUsername: { startsWith: normalize(prefix) } },
      select: { id: true }
    });
    const userIds = ownedUsers.map(({ id }) => id);
    if (userIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
      await prisma.authSession.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.BOOTSTRAP_ADMIN_USERNAME = `${prefix}-bootstrap`;
    process.env.BOOTSTRAP_ADMIN_NICKNAME = `并发根管理员-${runId}`;
    process.env.BOOTSTRAP_ADMIN_PASSWORD = `${randomUUID()}Aa1!`;
    app = await createApp();
    prisma = app.get(PrismaService);
    games = app.get(GamesService);
    await app.init();
    const username = `${prefix}-admin`;
    actor = await prisma.user.create({
      data: {
        username,
        normalizedUsername: normalize(username),
        nickname: `并发管理员-${runId}`,
        activeNormalizedNickname: normalize(`并发管理员-${runId}`),
        passwordHash: 'not-used-by-service-integration-tests',
        role: Role.ADMIN,
        avatarValue: 'preset-01'
      }
    });
  }, 30_000);

  beforeEach(async () => {
    await cleanGames();
  });

  afterAll(async () => {
    if (prisma !== undefined) await cleanRun();
    if (app !== undefined) await app.close();
  }, 30_000);

  it('serializes two simultaneous starts so only one third table opens', async () => {
    await seedGame('already-open', GameStatus.ACTIVE);
    const firstDraft = await seedGame('candidate-a');
    const secondDraft = await seedGame('candidate-b');

    const results = await Promise.allSettled([
      games.start(firstDraft.id, authUser(actor)),
      games.start(secondDraft.id, authUser(actor))
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find(({ status }) => status === 'rejected');
    expect(rejection).toMatchObject({ status: 'rejected', reason: { code: 'ACTIVE_GAME_LIMIT' } });
    await expect(prisma.game.count({
      where: { name: { startsWith: prefix }, status: { in: [GameStatus.ACTIVE, GameStatus.SETTLING] } }
    })).resolves.toBe(2);
    await expect(prisma.auditLog.count({
      where: { action: 'GAME_STARTED', entityId: { in: [firstDraft.id, secondDraft.id] } }
    })).resolves.toBe(1);
  });

  it('re-authorizes an actor after waiting for the lifecycle singleton lock', async () => {
    const draft = await seedGame('actor-demotion');
    let singletonLocked!: () => void;
    let releaseSingleton!: () => void;
    const locked = new Promise<void>((resolve) => { singletonLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseSingleton = resolve; });
    const blocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM system_settings WHERE id = 'singleton' FOR UPDATE
      `;
      singletonLocked();
      await release;
    }, { timeout: 10_000, maxWait: 5_000 });
    await locked;

    let settled = false;
    const start = games.start(draft.id, authUser(actor)).finally(() => { settled = true; });
    await delay(200);
    expect(settled).toBe(false);
    await prisma.user.update({ where: { id: actor.id }, data: { role: Role.USER } });
    releaseSingleton();
    await blocker;

    await expect(start).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(prisma.game.findUniqueOrThrow({ where: { id: draft.id } }))
      .resolves.toMatchObject({ status: GameStatus.DRAFT, version: 1 });
    await expect(prisma.auditLog.count({
      where: { action: 'GAME_STARTED', entityId: draft.id }
    })).resolves.toBe(0);
    actor = await prisma.user.update({ where: { id: actor.id }, data: { role: Role.ADMIN } });
  }, 15_000);

  it('keeps simultaneous start and begin-settlement transitions in a valid serial order', async () => {
    const draft = await seedGame('transition-race');

    const [start, settlement] = await Promise.allSettled([
      games.start(draft.id, authUser(actor)),
      games.beginSettlement(draft.id, authUser(actor))
    ]);

    expect(start.status).toBe('fulfilled');
    if (settlement.status === 'rejected') {
      expect(settlement.reason).toMatchObject({ code: 'GAME_STATE_CONFLICT' });
    }
    const stored = await prisma.game.findUniqueOrThrow({ where: { id: draft.id } });
    const settlementAudits = await prisma.auditLog.count({
      where: { action: 'GAME_SETTLEMENT_BEGUN', entityId: draft.id }
    });
    expect(
      { status: stored.status, version: stored.version, settlementAudits }
    ).toEqual(settlement.status === 'fulfilled'
      ? { status: GameStatus.SETTLING, version: 3, settlementAudits: 1 }
      : { status: GameStatus.ACTIVE, version: 2, settlementAudits: 0 });
    await expect(prisma.auditLog.count({
      where: { action: 'GAME_STARTED', entityId: draft.id }
    })).resolves.toBe(1);
  });

  it('shares a game FOR UPDATE helper that re-reads state after acquiring the lock', async () => {
    const active = await seedGame('task8-lock-protocol', GameStatus.ACTIVE);
    let gameLocked!: () => void;
    let releaseGame!: () => void;
    const locked = new Promise<void>((resolve) => { gameLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseGame = resolve; });
    const blocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM games WHERE id = ${active.id} FOR UPDATE
      `;
      gameLocked();
      await release;
      await transaction.game.update({
        where: { id: active.id },
        data: { status: GameStatus.VOIDED, stoppedAt: new Date(), version: { increment: 1 } }
      });
    }, { timeout: 10_000, maxWait: 5_000 });
    await locked;

    let consumerSettled = false;
    const consumer = prisma.$transaction(async (transaction) =>
      lockGameForUpdate(transaction, active.id)
    ).finally(() => { consumerSettled = true; });
    await delay(200);
    expect(consumerSettled).toBe(false);
    releaseGame();
    await blocker;

    await expect(consumer).resolves.toMatchObject({
      id: active.id,
      status: GameStatus.VOIDED,
      version: 2
    });
  }, 15_000);
});
