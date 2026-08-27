import type { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import mariadb from 'mariadb';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { AuditService } from '../src/audit/audit.service.js';
import {
  BuyinEventType,
  GameStatus,
  Prisma,
  Role,
  type Game,
  type GamePlayer,
  type SystemSetting,
  type User
} from '../src/generated/prisma/client.js';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SettlementDraftService } from '../src/settlements/settlement-draft.service.js';
import { SettlementFinalizationService } from '../src/settlements/settlement-finalization.service.js';
import * as userPolicy from '../src/users/user-policy.js';
import { requireAuthorizedTestDatabase } from './support/authorized-test-database.js';

const databaseUrl = requireAuthorizedTestDatabase();
const databaseName = databaseUrl.pathname.slice(1);

const runId = randomUUID().replaceAll('-', '').slice(0, 10);
const prefix = `settlement-concurrency-${runId}`;

interface Fixture {
  game: Game;
  players: [GamePlayer, GamePlayer];
}

function normalize(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function updateRakeOutsidePrismaPool(userId: string, rakeEnabled: boolean): Promise<void> {
  const connection = await mariadb.createConnection({
    host: databaseUrl.hostname,
    port: Number(databaseUrl.port || 3306),
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password),
    database: databaseName,
    connectTimeout: 5_000
  });
  try {
    await connection.query('SET SESSION innodb_lock_wait_timeout = 1');
    await connection.query('UPDATE users SET rake_enabled = ? WHERE id = ?', [rakeEnabled, userId]);
  } finally {
    await connection.end();
  }
}

async function lockUserOutsidePrismaPool(userId: string): Promise<() => Promise<void>> {
  const connection = await mariadb.createConnection({
    host: databaseUrl.hostname,
    port: Number(databaseUrl.port || 3306),
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password),
    database: databaseName,
    connectTimeout: 5_000
  });
  try {
    await connection.beginTransaction();
    await connection.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
  } catch (error) {
    await connection.end();
    throw error;
  }
  return async () => {
    try {
      await connection.commit();
    } finally {
      await connection.end();
    }
  };
}

function retryableConflict(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('injected serializable conflict', {
    code: 'P2034',
    clientVersion: '7.9.1'
  });
}

describe.sequential('settlement finalization concurrency and rollback', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let drafts: SettlementDraftService;
  let finalization: SettlementFinalizationService;
  let audit: AuditService;
  let adminA: User;
  let adminB: User;
  let playerA: User;
  let playerB: User;
  let originalSettings: SystemSetting;

  async function seedUser(suffix: string, role: Role): Promise<User> {
    const username = `${prefix}-${suffix}`;
    const nickname = `并发-${runId}-${suffix}`;
    return prisma.user.create({
      data: {
        username,
        normalizedUsername: normalize(username),
        nickname,
        activeNormalizedNickname: normalize(nickname),
        passwordHash: 'not-used-by-service-integration-tests',
        role,
        avatarValue: 'preset-01'
      }
    });
  }

  async function seedFixture(
    suffix: string,
    expiredLease = false,
    creator = adminA,
    editor = adminA
  ): Promise<Fixture> {
    const startedAt = new Date(Date.now() - 60_000);
    const game = await prisma.game.create({
      data: {
        name: `${prefix}-${suffix}`,
        handPrice: 300n,
        rakeEnabled: true,
        status: GameStatus.SETTLING,
        version: 4,
        createdById: creator.id,
        startedAt,
        stoppedAt: new Date()
      }
    });
    const players: GamePlayer[] = [];
    for (const [index, user] of [playerA, playerB].entries()) {
      const player = await prisma.gamePlayer.create({
        data: {
          gameId: game.id,
          userId: user.id,
          nicknameSnapshot: `${user.nickname}-snapshot`,
          avatarKindSnapshot: user.avatarKind,
          avatarValueSnapshot: user.avatarValue,
          seatNo: index + 1,
          firstBuyinAt: startedAt
        }
      });
      const eventId = randomBytes(15).toString('hex');
      await prisma.buyinEvent.create({
        data: {
          id: eventId,
          gameId: game.id,
          gamePlayerId: player.id,
          actorUserId: user.id,
          type: BuyinEventType.BUY,
          logicalBuyId: eventId,
          previousHands: null,
          newHands: 1,
          handsDelta: 1,
          gameVersion: index + 2,
          idempotencyKey: `${prefix}-${suffix}-${index}`
        }
      });
      await prisma.activePlayerLock.create({ data: { gameId: game.id, userId: user.id } });
      players.push(player);
    }
    const typedPlayers = players as Fixture['players'];
    await prisma.settlementDraft.create({
      data: {
        gameId: game.id,
        editorUserId: editor.id,
        updatedById: editor.id,
        leaseExpiresAt: new Date(Date.now() + (expiredLease ? -1_000 : 300_000)),
        version: 4,
        payload: {
          cashOutByPlayerId: {
            [typedPlayers[0].id]: '600',
            [typedPlayers[1].id]: '0'
          },
          roomFee: '1',
          roomPayerIds: [typedPlayers[0].id, typedPlayers[1].id],
          otherFee: '1',
          otherFeeNote: 'rollback-proof',
          otherPayerIds: [typedPlayers[0].id, typedPlayers[1].id]
        }
      }
    });
    return { game, players: typedPlayers };
  }

  async function commandFor(fixture: Fixture, editor = adminA) {
    const preview = await drafts.get(fixture.game.id, authUser(editor));
    if (preview.confirmationToken === null) throw new Error('expected ready settlement preview');
    return {
      draftVersion: preview.draftVersion,
      settingsVersion: preview.settingsVersion,
      confirmationToken: preview.confirmationToken
    };
  }

  async function assertNotFinalized(fixture: Fixture): Promise<void> {
    await expect(prisma.settlement.count({ where: { gameId: fixture.game.id } })).resolves.toBe(0);
    await expect(prisma.settlementResult.count({
      where: { gamePlayerId: { in: fixture.players.map(({ id }) => id) } }
    })).resolves.toBe(0);
    await expect(prisma.settlementFeeAllocation.count({
      where: { gamePlayerId: { in: fixture.players.map(({ id }) => id) } }
    })).resolves.toBe(0);
    await expect(prisma.game.findUniqueOrThrow({ where: { id: fixture.game.id } }))
      .resolves.toMatchObject({ status: GameStatus.SETTLING, completedAt: null, settledById: null });
    await expect(prisma.activePlayerLock.count({ where: { gameId: fixture.game.id } })).resolves.toBe(2);
    await expect(prisma.auditLog.count({
      where: { action: 'SETTLEMENT_FINALIZED', actorUserId: adminA.id }
    })).resolves.toBe(0);
  }

  async function ownedGraph() {
    const users = await prisma.user.findMany({
      where: { normalizedUsername: { startsWith: normalize(prefix) } },
      select: { id: true }
    });
    const userIds = users.map(({ id }) => id);
    const games = await prisma.game.findMany({
      where: { name: { startsWith: prefix } },
      include: {
        players: { select: { id: true, userId: true } },
        buyinEvents: { select: { actorUserId: true } },
        activeLocks: { select: { userId: true } },
        settlementDraft: { select: { id: true, editorUserId: true, updatedById: true } },
        settlement: { select: { id: true, settledById: true } }
      }
    });
    const ownedUsers = new Set(userIds);
    for (const game of games) {
      if (!ownedUsers.has(game.createdById) || (game.settledById !== null && !ownedUsers.has(game.settledById))) {
        throw new Error('Task 11 game ownership graph is not closed');
      }
      if (game.players.some(({ userId }) => !ownedUsers.has(userId)) ||
          game.buyinEvents.some(({ actorUserId }) => !ownedUsers.has(actorUserId)) ||
          game.activeLocks.some(({ userId }) => !ownedUsers.has(userId)) ||
          (game.settlementDraft !== null &&
            (!ownedUsers.has(game.settlementDraft.editorUserId) || !ownedUsers.has(game.settlementDraft.updatedById))) ||
          (game.settlement !== null && !ownedUsers.has(game.settlement.settledById))) {
        throw new Error('Task 11 relationship ownership graph is not closed');
      }
    }
    return {
      userIds,
      gameIds: games.map(({ id }) => id),
      playerIds: games.flatMap(({ players }) => players.map(({ id }) => id)),
      draftIds: games.flatMap(({ settlementDraft }) => settlementDraft === null ? [] : [settlementDraft.id]),
      settlementIds: games.flatMap(({ settlement }) => settlement === null ? [] : [settlement.id])
    };
  }

  async function cleanOwnedGames(): Promise<void> {
    const graph = await ownedGraph();
    if (graph.gameIds.length === 0) return;
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { entityType: 'GAME', entityId: { in: graph.gameIds } },
          ...(graph.draftIds.length === 0
            ? []
            : [{ entityType: 'SETTLEMENT_DRAFT', entityId: { in: graph.draftIds } }]),
          ...(graph.settlementIds.length === 0
            ? []
            : [{ entityType: 'SETTLEMENT', entityId: { in: graph.settlementIds } }])
        ]
      }
    });
    if (graph.playerIds.length > 0) {
      await prisma.settlementFeeAllocation.deleteMany({ where: { gamePlayerId: { in: graph.playerIds } } });
      await prisma.settlementResult.deleteMany({ where: { gamePlayerId: { in: graph.playerIds } } });
    }
    await prisma.settlement.deleteMany({ where: { gameId: { in: graph.gameIds } } });
    await prisma.settlementDraft.deleteMany({ where: { gameId: { in: graph.gameIds } } });
    await prisma.buyinEvent.deleteMany({ where: { gameId: { in: graph.gameIds } } });
    await prisma.activePlayerLock.deleteMany({ where: { gameId: { in: graph.gameIds } } });
    await prisma.gamePlayer.deleteMany({ where: { gameId: { in: graph.gameIds } } });
    await prisma.game.deleteMany({ where: { id: { in: graph.gameIds } } });
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.CSRF_SECRET = randomUUID();
    process.env.BOOTSTRAP_ADMIN_USERNAME = `${prefix}-bootstrap`;
    process.env.BOOTSTRAP_ADMIN_NICKNAME = `并发根-${runId}`;
    process.env.BOOTSTRAP_ADMIN_PASSWORD = `${randomUUID()}Aa1!`;
    app = await createApp();
    prisma = app.get(PrismaService);
    drafts = app.get(SettlementDraftService);
    finalization = app.get(SettlementFinalizationService);
    audit = app.get(AuditService);
    await app.init();
    adminA = await seedUser('admin-a', Role.ADMIN);
    adminB = await seedUser('admin-b', Role.ADMIN);
    playerA = await seedUser('player-a', Role.USER);
    playerB = await seedUser('player-b', Role.USER);
    originalSettings = await prisma.systemSetting.findUniqueOrThrow({ where: { id: 'singleton' } });
  }, 30_000);

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanOwnedGames();
    adminA = await prisma.user.update({ where: { id: adminA.id }, data: { role: Role.ADMIN } });
    adminB = await prisma.user.update({ where: { id: adminB.id }, data: { role: Role.ADMIN } });
    playerA = await prisma.user.update({ where: { id: playerA.id }, data: { rakeEnabled: true } });
    playerB = await prisma.user.update({ where: { id: playerB.id }, data: { rakeEnabled: true } });
    await prisma.systemSetting.update({
      where: { id: 'singleton' },
      data: { rakeThreshold: 1000n, rakeBps: 1000, version: 41, updatedById: null }
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (prisma !== undefined) {
      await cleanOwnedGames();
      if (originalSettings !== undefined) {
        await prisma.systemSetting.update({
          where: { id: 'singleton' },
          data: {
            rakeThreshold: originalSettings.rakeThreshold,
            rakeBps: originalSettings.rakeBps,
            version: originalSettings.version,
            updatedById: originalSettings.updatedById
          }
        });
      }
      const graph = await ownedGraph();
      if (graph.userIds.length > 0) {
        await prisma.auditLog.deleteMany({ where: { actorUserId: { in: graph.userIds } } });
        await prisma.authSession.deleteMany({ where: { userId: { in: graph.userIds } } });
        await prisma.activePlayerLock.deleteMany({ where: { userId: { in: graph.userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: graph.userIds } } });
      }
    }
    if (app !== undefined) await app.close();
  }, 30_000);

  it('re-authorizes a demoted actor after finalization waits for the settings lock', async () => {
    // Break caught: an actor authorized before waiting can still commit after a concurrent demotion.
    const fixture = await seedFixture('actor-demotion');
    const command = await commandFor(fixture);
    let settingsLocked!: () => void;
    let releaseSettings!: () => void;
    const locked = new Promise<void>((resolve) => { settingsLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseSettings = resolve; });
    const blocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM system_settings WHERE id = 'singleton' FOR UPDATE
      `;
      settingsLocked();
      await release;
      await transaction.user.update({ where: { id: adminA.id }, data: { role: Role.USER } });
    }, { timeout: 10_000, maxWait: 5_000 });
    await locked;

    let settled = false;
    const result = finalization.finalize(fixture.game.id, authUser(adminA), command)
      .finally(() => { settled = true; });
    await delay(200);
    expect(settled).toBe(false);
    releaseSettings();
    await blocker;

    await expect(result).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await assertNotFinalized(fixture);
  }, 15_000);

  it('rejects an old editor after a committed lease takeover while finalization waits', async () => {
    // Break caught: expiry or a stale editor snapshot lets the displaced editor finalize after takeover.
    const fixture = await seedFixture('lease-takeover', true);
    const command = await commandFor(fixture);
    let settingsLocked!: () => void;
    let releaseSettings!: () => void;
    const locked = new Promise<void>((resolve) => { settingsLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseSettings = resolve; });
    const blocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM system_settings WHERE id = 'singleton' FOR UPDATE
      `;
      settingsLocked();
      await release;
    }, { timeout: 10_000, maxWait: 5_000 });
    await locked;

    let settled = false;
    const result = finalization.finalize(fixture.game.id, authUser(adminA), command)
      .finally(() => { settled = true; });
    await delay(200);
    expect(settled).toBe(false);
    await expect(drafts.takeover(fixture.game.id, authUser(adminB)))
      .resolves.toMatchObject({ editorUserId: adminB.id, version: 5 });
    releaseSettings();
    await blocker;

    await expect(result).rejects.toMatchObject({ code: 'DRAFT_EDITOR_CONFLICT' });
    await assertNotFinalized(fixture);
  }, 15_000);

  it('rejects settings committed after preview while finalization waits', async () => {
    // Break caught: finalization uses the preview settings after a newer settings transaction commits.
    const fixture = await seedFixture('settings-change');
    const command = await commandFor(fixture);
    let settingsLocked!: () => void;
    let releaseSettings!: () => void;
    const locked = new Promise<void>((resolve) => { settingsLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseSettings = resolve; });
    const blocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM system_settings WHERE id = 'singleton' FOR UPDATE
      `;
      settingsLocked();
      await release;
      await transaction.systemSetting.update({
        where: { id: 'singleton' }, data: { rakeBps: 900, version: { increment: 1 } }
      });
    }, { timeout: 10_000, maxWait: 5_000 });
    await locked;

    const result = finalization.finalize(fixture.game.id, authUser(adminA), command);
    await delay(200);
    releaseSettings();
    await blocker;

    await expect(result).rejects.toMatchObject({ code: 'SETTINGS_VERSION_CONFLICT' });
    await assertNotFinalized(fixture);
  }, 15_000);

  it('rejects a participant rake change committed after preview while finalization waits', async () => {
    // Break caught: confirmation validates a stale participant rake flag after a concurrent profile update.
    const fixture = await seedFixture('rake-change');
    const command = await commandFor(fixture);
    let gameLocked!: () => void;
    let releaseGame!: () => void;
    const locked = new Promise<void>((resolve) => { gameLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseGame = resolve; });
    const blocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM games WHERE id = ${fixture.game.id} FOR UPDATE
      `;
      gameLocked();
      await release;
      await transaction.user.update({ where: { id: playerA.id }, data: { rakeEnabled: false } });
    }, { timeout: 10_000, maxWait: 5_000 });
    await locked;

    let settled = false;
    const result = finalization.finalize(fixture.game.id, authUser(adminA), command)
      .finally(() => { settled = true; });
    await delay(200);
    expect(settled).toBe(false);
    releaseGame();
    await blocker;

    await expect(result).rejects.toMatchObject({ code: 'SETTLEMENT_PREVIEW_CONFLICT' });
    await assertNotFinalized(fixture);
  }, 15_000);

  it('uses participant rake rows locked after the player query instead of its stale relation snapshot', async () => {
    // Break caught: finalization signs and calculates with player.user.rakeEnabled read before explicit user locks.
    const fixture = await seedFixture('rake-narrow-window');
    const command = await commandFor(fixture);
    const ordered = [adminA.id, playerA.id, playerB.id].sort();
    const blockedUserId = ordered[0]!;
    const target = blockedUserId === playerA.id ? playerB : playerA;
    const releaseUserLock = await lockUserOutsidePrismaPool(blockedUserId);
    let signalUserLockQuery!: () => void;
    const userLockQueryReached = new Promise<void>((resolve) => { signalUserLockQuery = resolve; });
    const originalLockUsersInOrder = userPolicy.lockUsersInOrder;
    vi.spyOn(userPolicy, 'lockUsersInOrder').mockImplementation(async (transaction, ids) => {
      const actualIds = [...new Set(ids)].sort();
      if (actualIds.length === ordered.length && actualIds.every((id, index) => id === ordered[index])) {
        signalUserLockQuery();
      }
      return originalLockUsersInOrder(transaction, ids);
    });

    const result = finalization.finalize(fixture.game.id, authUser(adminA), command).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    );
    let updateError: unknown;
    try {
      try {
        await Promise.race([
          userLockQueryReached,
          delay(10_000).then(() => {
            throw new Error('This finalization did not reach its exact participant user-lock query');
          })
        ]);
        await updateRakeOutsidePrismaPool(target.id, false);
      } catch (error) {
        updateError = error;
      }
    } finally {
      try {
        await releaseUserLock();
      } finally {
        await result;
      }
    }

    expect(updateError).toBeUndefined();
    await expect(result).resolves.toMatchObject({
      status: 'rejected',
      reason: { code: 'SETTLEMENT_PREVIEW_CONFLICT' }
    });
    await assertNotFinalized(fixture);
  }, 30_000);

  it('retries the whole serializable transaction only within the P2034 bound', async () => {
    // Break caught: retry is unbounded, does not retry P2034, or duplicates writes across attempts.
    const fixture = await seedFixture('retry-success');
    const command = await commandFor(fixture);
    const originalTransaction = prisma.$transaction;
    let attempts = 0;
    vi.spyOn(prisma, '$transaction').mockImplementation((async (...args: unknown[]) => {
      attempts += 1;
      if (attempts < 3) throw retryableConflict();
      return Reflect.apply(originalTransaction, prisma, args);
    }) as never);

    await expect(finalization.finalize(fixture.game.id, authUser(adminA), command))
      .resolves.toMatchObject({ immutable: true });
    expect(attempts).toBe(3);
    await expect(prisma.settlement.count({ where: { gameId: fixture.game.id } })).resolves.toBe(1);
    await expect(prisma.settlementResult.count({
      where: { settlement: { gameId: fixture.game.id } }
    })).resolves.toBe(2);
  }, 15_000);

  it('stops after the P2034 retry bound without creating a settlement', async () => {
    // Break caught: the final failed retry leaks writes or silently attempts a fourth transaction.
    const fixture = await seedFixture('retry-failure');
    const command = await commandFor(fixture);
    let attempts = 0;
    vi.spyOn(prisma, '$transaction').mockImplementation((async () => {
      attempts += 1;
      throw retryableConflict();
    }) as never);

    await expect(finalization.finalize(fixture.game.id, authUser(adminA), command))
      .rejects.toMatchObject({ code: 'P2034' });
    expect(attempts).toBe(3);
    vi.restoreAllMocks();
    await assertNotFinalized(fixture);
  }, 15_000);

  it('rolls back settlement, completion, lock release, and audit after writes begin', async () => {
    // Break caught: a late transaction failure leaves any permanent settlement side effect committed.
    const fixture = await seedFixture('rollback');
    const command = await commandFor(fixture);
    const originalRecord = audit.record.bind(audit);
    vi.spyOn(audit, 'record').mockImplementationOnce(async (transaction, entry) => {
      await originalRecord(transaction, entry);
      throw new Error('injected failure after settlement audit write');
    });

    await expect(finalization.finalize(fixture.game.id, authUser(adminA), command))
      .rejects.toThrow('injected failure after settlement audit write');
    await assertNotFinalized(fixture);
  }, 15_000);

  it('creates one permanent settlement and gives the duplicate loser a deterministic conflict', async () => {
    // Break caught: duplicate submit creates two settlements or exposes a raw database race error.
    const fixture = await seedFixture('duplicate');
    const command = await commandFor(fixture);
    const outcomes = await Promise.allSettled([
      finalization.finalize(fixture.game.id, authUser(adminA), command),
      finalization.finalize(fixture.game.id, authUser(adminA), command)
    ]);

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(({ status }) => status === 'rejected'))
      .toMatchObject({ status: 'rejected', reason: { code: 'GAME_STATE_CONFLICT' } });
    await expect(prisma.settlement.count({ where: { gameId: fixture.game.id } })).resolves.toBe(1);
    await expect(prisma.settlementResult.count({
      where: { settlement: { gameId: fixture.game.id } }
    })).resolves.toBe(2);
    await expect(prisma.activePlayerLock.count({ where: { gameId: fixture.game.id } })).resolves.toBe(0);
  }, 30_000);

  it('persists one immutable settlement when its creator races an administrator', async () => {
    // Break caught: owner authorization or the finalization race permits two persisted settlements.
    const fixture = await seedFixture('creator-admin-race', false, playerA, playerA);
    const command = await commandFor(fixture, playerA);
    const outcomes = await Promise.allSettled([
      finalization.finalize(fixture.game.id, authUser(playerA), command),
      finalization.finalize(fixture.game.id, authUser(adminA), command)
    ]);

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(({ status }) => status === 'fulfilled'))
      .toMatchObject({ status: 'fulfilled', value: { immutable: true } });
    const rejected = outcomes.find(({ status }) => status === 'rejected');
    if (rejected === undefined || rejected.status !== 'rejected') {
      throw new Error('expected exactly one rejected finalization');
    }
    expect(['DRAFT_EDITOR_CONFLICT', 'GAME_STATE_CONFLICT']).toContain(
      (rejected.reason as { code: string }).code
    );
    await expect(prisma.settlement.count({ where: { gameId: fixture.game.id } })).resolves.toBe(1);
    await expect(prisma.settlementResult.count({ where: { settlement: { gameId: fixture.game.id } } }))
      .resolves.toBe(2);
  }, 30_000);
});
