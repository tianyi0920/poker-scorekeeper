import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { GameStatus, Role, type Game, type User } from '../src/generated/prisma/client.js';
import { lockGameForUpdate } from '../src/games/game-lock.js';
import { GamesService } from '../src/games/games.service.js';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { lockUsersInOrder } from '../src/users/user-policy.js';
import { requireAuthorizedTestDatabase } from './support/authorized-test-database.js';

requireAuthorizedTestDatabase();

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
    mustChangePassword: user.mustChangePassword,
    avatarKind: user.avatarKind,
    avatarValue: user.avatarValue
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

  it('serializes two simultaneous starts so only one fifth table opens', async () => {
    await seedGame('already-open-1', GameStatus.ACTIVE);
    await seedGame('already-open-2', GameStatus.ACTIVE);
    await seedGame('already-open-3', GameStatus.ACTIVE);
    await seedGame('already-open-4', GameStatus.ACTIVE);
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
    })).resolves.toBe(5);
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
    const startResult = start.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    );
    await delay(200);
    expect(settled).toBe(false);
    await prisma.user.update({ where: { id: actor.id }, data: { role: Role.USER } });
    releaseSingleton();
    await blocker;

    await expect(startResult).resolves.toMatchObject({
      status: 'rejected', reason: { code: 'FORBIDDEN' }
    });
    await expect(prisma.game.findUniqueOrThrow({ where: { id: draft.id } }))
      .resolves.toMatchObject({ status: GameStatus.DRAFT, version: 1 });
    await expect(prisma.auditLog.count({
      where: { action: 'GAME_STARTED', entityId: draft.id }
    })).resolves.toBe(0);
    actor = await prisma.user.update({ where: { id: actor.id }, data: { role: Role.ADMIN } });
  }, 15_000);

  it('re-authorizes begin-settlement after its actor row is concurrently demoted', async () => {
    const active = await seedGame('actor-row-demotion', GameStatus.ACTIVE);
    let actorLocked!: () => void;
    let releaseActor!: () => void;
    const locked = new Promise<void>((resolve) => { actorLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseActor = resolve; });
    const blocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM users WHERE id = ${actor.id} FOR UPDATE
      `;
      actorLocked();
      await release;
      await transaction.user.update({ where: { id: actor.id }, data: { role: Role.USER } });
    }, { timeout: 10_000, maxWait: 5_000 });
    await locked;

    let settled = false;
    const settlement = games.beginSettlement(active.id, authUser(actor))
      .finally(() => { settled = true; });
    const settlementResult = settlement.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    );
    await delay(200);
    expect(settled).toBe(false);
    releaseActor();
    await blocker;

    try {
      await expect(settlementResult).resolves.toMatchObject({
        status: 'rejected', reason: { code: 'FORBIDDEN' }
      });
      await expect(prisma.game.findUniqueOrThrow({ where: { id: active.id } }))
        .resolves.toMatchObject({ status: GameStatus.ACTIVE, version: 1, stoppedAt: null });
      await expect(prisma.auditLog.count({
        where: { action: 'GAME_SETTLEMENT_BEGUN', entityId: active.id }
      })).resolves.toBe(0);
    } finally {
      actor = await prisma.user.update({ where: { id: actor.id }, data: { role: Role.ADMIN } });
    }
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

  it('returns current game state after a consistent read established an older snapshot', async () => {
    const active = await seedGame('task8-lock-protocol', GameStatus.ACTIVE);
    let snapshotRead!: () => void;
    let acquireLock!: () => void;
    const read = new Promise<void>((resolve) => { snapshotRead = resolve; });
    const proceed = new Promise<void>((resolve) => { acquireLock = resolve; });
    const consumer = prisma.$transaction(async (transaction) => {
      const stale = await transaction.game.findUniqueOrThrow({ where: { id: active.id } });
      expect(stale).toMatchObject({ status: GameStatus.ACTIVE, version: 1 });
      snapshotRead();
      await proceed;
      return lockGameForUpdate(transaction, active.id);
    }, { timeout: 10_000, maxWait: 5_000 });
    await read;
    await prisma.game.update({
      where: { id: active.id },
      data: { status: GameStatus.VOIDED, stoppedAt: new Date(), version: { increment: 1 } }
    });
    acquireLock();

    await expect(consumer).resolves.toMatchObject({
      id: active.id,
      status: GameStatus.VOIDED,
      version: 2
    });
  }, 15_000);

  it('returns current actor fields after a consistent read established an older snapshot', async () => {
    const active = await seedGame('actor-lock-protocol', GameStatus.ACTIVE);
    let snapshotRead!: () => void;
    let acquireLock!: () => void;
    const read = new Promise<void>((resolve) => { snapshotRead = resolve; });
    const proceed = new Promise<void>((resolve) => { acquireLock = resolve; });
    const consumer = prisma.$transaction(async (transaction) => {
      await transaction.game.findUniqueOrThrow({ where: { id: active.id } });
      snapshotRead();
      await proceed;
      return lockUsersInOrder(transaction, [actor.id]);
    }, { timeout: 10_000, maxWait: 5_000 });
    await read;
    await prisma.user.update({ where: { id: actor.id }, data: { role: Role.USER } });
    acquireLock();

    try {
      const locked = await consumer;
      expect(locked.get(actor.id)).toMatchObject({ id: actor.id, role: Role.USER });
    } finally {
      actor = await prisma.user.update({ where: { id: actor.id }, data: { role: Role.ADMIN } });
    }
  }, 15_000);
});
