import type { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import mariadb, { type Connection } from 'mariadb';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuyinsService } from '../src/buyins/buyins.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import {
  BuyinEventType,
  GameStatus,
  Prisma,
  Role,
  type Game,
  type GamePlayer,
  type User
} from '../src/generated/prisma/client.js';
import { GameManagementService } from '../src/games/game-management.service.js';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SettlementDraftService } from '../src/settlements/settlement-draft.service.js';
import { SettlementFinalizationService } from '../src/settlements/settlement-finalization.service.js';
import { requireAuthorizedTestDatabase } from './support/authorized-test-database.js';

const databaseUrl = requireAuthorizedTestDatabase();
const databaseName = databaseUrl.pathname.slice(1);
const runId = randomUUID().replaceAll('-', '').slice(0, 10);
const prefix = `hard-delete-${runId}`;
const activeGameId = `hd-${runId}-a`;
const settlingGameId = `hd-${runId}-s`;

interface SettlementFixture {
  game: Game;
  players: [GamePlayer, GamePlayer];
}

interface GameBlocker {
  processId: number;
  release(): Promise<void>;
}

type TransactionPhase = 'deleter' | 'buyin' | 'finalization';

interface ProcessRow {
  processId: number | bigint;
  command: string;
  queryText: string | null;
}

interface ConnectionIdRow {
  connectionId: number | bigint;
}

interface InteractiveTransactionOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

interface InteractiveTransactionRunner {
  $transaction<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
    options?: InteractiveTransactionOptions
  ): Promise<T>;
}

interface TransactionConnectionProbe {
  setPhase(phase: TransactionPhase): void;
  waitForConnection(phase: TransactionPhase): Promise<number>;
  restore(): void;
}

type CapturedOutcome =
  | { status: 'fulfilled'; value: unknown }
  | { status: 'rejected'; reason: unknown };

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

function connectionOptions() {
  return {
    host: databaseUrl.hostname,
    port: Number(databaseUrl.port || 3306),
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password),
    database: databaseName,
    connectTimeout: 5_000
  };
}

async function waitForCondition<T>(
  description: string,
  read: () => Promise<T | null>,
  timeoutMilliseconds = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== null) return result;
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function lockGameOutsidePrisma(gameId: string): Promise<GameBlocker> {
  const connection = await mariadb.createConnection(connectionOptions());
  let released = false;
  try {
    await connection.beginTransaction();
    const [identity] = await connection.query<ConnectionIdRow[]>('SELECT CONNECTION_ID() AS connectionId');
    if (identity === undefined) throw new Error('Blocker connection has no connection ID');
    await connection.query('SELECT id FROM games WHERE id = ? FOR UPDATE', [gameId]);
    return {
      processId: Number(identity.connectionId),
      async release() {
        if (released) return;
        released = true;
        try {
          await connection.commit();
        } finally {
          await connection.end();
        }
      }
    };
  } catch (error) {
    await connection.end();
    throw error;
  }
}

function observeInteractiveTransactions(prisma: PrismaService): TransactionConnectionProbe {
  const runner = prisma as unknown as InteractiveTransactionRunner;
  const originalTransaction = runner.$transaction.bind(runner);
  const observed = new Map<TransactionPhase, number>();
  const waiters = new Map<TransactionPhase, (processId: number) => void>();
  let currentPhase: TransactionPhase = 'deleter';
  const transactionSpy = vi.spyOn(runner, '$transaction');
  transactionSpy.mockImplementation(async <T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
    options?: InteractiveTransactionOptions
  ): Promise<T> => {
    const phase = currentPhase;
    return originalTransaction(async (transaction) => {
      const [identity] = await transaction.$queryRaw<ConnectionIdRow[]>`
        SELECT CONNECTION_ID() AS connectionId
      `;
      if (identity === undefined) throw new Error(`No connection ID for ${phase} transaction`);
      const processId = Number(identity.connectionId);
      if (!observed.has(phase)) {
        observed.set(phase, processId);
        waiters.get(phase)?.(processId);
        waiters.delete(phase);
      }
      return operation(transaction);
    }, options);
  });
  return {
    setPhase(phase) {
      currentPhase = phase;
    },
    waitForConnection(phase) {
      const processId = observed.get(phase);
      if (processId !== undefined) return Promise.resolve(processId);
      return new Promise<number>((resolve) => { waiters.set(phase, resolve); });
    },
    restore() {
      transactionSpy.mockRestore();
    }
  };
}

async function readProcess(
  monitor: Connection,
  processId: number
): Promise<ProcessRow | null> {
  const rows = await monitor.query<ProcessRow[]>(`
    SELECT ID AS processId, COMMAND AS command, INFO AS queryText
    FROM information_schema.PROCESSLIST
    WHERE DB = ? AND ID = ?
  `, [databaseName, processId]);
  return rows[0] ?? null;
}

async function waitForExactLockQuery(
  monitor: Connection,
  processId: number,
  tableName: 'games' | 'system_settings',
): Promise<ProcessRow> {
  return waitForCondition(
    `connection ${processId} executing ${tableName} FOR UPDATE`,
    async () => {
      const row = await readProcess(monitor, processId);
      const normalized = row?.queryText?.toLowerCase() ?? '';
      return row !== null && row.command === 'Execute'
        && normalized.includes(`from ${tableName}`) && normalized.includes('for update')
        ? row
        : null;
    }
  );
}

async function expectBlockerTransaction(monitor: Connection, blocker: GameBlocker): Promise<void> {
  const process = await waitForCondition(
    `blocker connection ${blocker.processId}`,
    () => readProcess(monitor, blocker.processId)
  );
  expect({
    processId: Number(process.processId),
    command: process.command,
    queryText: process.queryText
  }).toEqual({
    processId: blocker.processId,
    command: 'Sleep',
    queryText: null
  });
  const transactions = await monitor.query<Array<{ processId: number | bigint }>>(`
    SELECT trx_mysql_thread_id AS processId
    FROM information_schema.INNODB_TRX
    WHERE trx_mysql_thread_id = ?
  `, [blocker.processId]);
  expect(transactions.map(({ processId }) => Number(processId))).toEqual([blocker.processId]);
}

function expectExactLockQuery(
  row: ProcessRow,
  processId: number,
  tableName: 'games' | 'system_settings'
): void {
  expect(Number(row.processId)).toBe(processId);
  expect(row.command).toBe('Execute');
  const normalized = row.queryText?.toLowerCase() ?? '';
  expect(normalized).toContain(`from ${tableName}`);
  expect(normalized).toContain('for update');
}

async function expectConnectionRemainsBlocked(
  monitor: Connection,
  processId: number,
  tableName: 'games' | 'system_settings'
): Promise<void> {
  await monitor.query('SELECT 1');
  const row = await readProcess(monitor, processId);
  expect(row).not.toBeNull();
  expectExactLockQuery(row!, processId, tableName);
}

describe.sequential('transactional hard-delete lock ordering', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let management: GameManagementService;
  let buyins: BuyinsService;
  let drafts: SettlementDraftService;
  let finalization: SettlementFinalizationService;
  let monitor: Connection;
  let superAdmin: User;
  let admin: User;
  let playerA: User;
  let playerB: User;

  async function seedUser(suffix: string, role: Role): Promise<User> {
    const username = `${prefix}-${suffix}`;
    const nickname = `硬删除-${runId}-${suffix}`;
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

  async function seedActiveGame(): Promise<Game> {
    return prisma.game.create({
      data: {
        id: activeGameId,
        name: `${prefix}-active`,
        handPrice: 300n,
        rakeEnabled: true,
        status: GameStatus.ACTIVE,
        version: 1,
        createdById: admin.id,
        startedAt: new Date()
      }
    });
  }

  async function seedSettlementFixture(): Promise<SettlementFixture> {
    const startedAt = new Date(Date.now() - 60_000);
    const game = await prisma.game.create({
      data: {
        id: settlingGameId,
        name: `${prefix}-settling`,
        handPrice: 300n,
        rakeEnabled: true,
        status: GameStatus.SETTLING,
        version: 4,
        createdById: admin.id,
        startedAt,
        stoppedAt: new Date()
      }
    });
    const users = [playerA, playerB] as const;
    const players: GamePlayer[] = [];
    for (const [index, user] of users.entries()) {
      const player = await prisma.gamePlayer.create({
        data: {
          id: `${settlingGameId}-p${index + 1}`,
          gameId: game.id,
          userId: user.id,
          nicknameSnapshot: user.nickname,
          avatarKindSnapshot: user.avatarKind,
          avatarValueSnapshot: user.avatarValue,
          seatNo: index + 1,
          firstBuyinAt: startedAt
        }
      });
      const eventId = `${settlingGameId}-e${index + 1}`;
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
          idempotencyKey: `${prefix}-settlement-buy-${index + 1}`
        }
      });
      await prisma.activePlayerLock.create({ data: { gameId: game.id, userId: user.id } });
      players.push(player);
    }
    const typedPlayers = players as SettlementFixture['players'];
    await prisma.settlementDraft.create({
      data: {
        id: `${settlingGameId}-dr`,
        gameId: game.id,
        editorUserId: admin.id,
        updatedById: admin.id,
        leaseExpiresAt: new Date(Date.now() + 300_000),
        version: 4,
        payload: {
          cashOutByPlayerId: { [typedPlayers[0].id]: '600', [typedPlayers[1].id]: '0' },
          roomFee: '0', roomPayerIds: [], otherFee: '0', otherFeeNote: '', otherPayerIds: []
        }
      }
    });
    return { game, players: typedPlayers };
  }

  async function cleanOwnedGraph(): Promise<void> {
    const gameIds = [activeGameId, settlingGameId];
    const settlements = await prisma.settlement.findMany({
      where: { gameId: { in: gameIds } }, select: { id: true }
    });
    const settlementIds = settlements.map(({ id }) => id);
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { entityType: 'GAME', entityId: { in: gameIds } },
          { actorUserId: { in: [superAdmin.id, admin.id, playerA.id, playerB.id] } }
        ]
      }
    });
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

  async function expectNoBusinessRows(gameId: string): Promise<void> {
    await expect(Promise.all([
      prisma.game.count({ where: { id: gameId } }),
      prisma.gamePlayer.count({ where: { gameId } }),
      prisma.buyinEvent.count({ where: { gameId } }),
      prisma.activePlayerLock.count({ where: { gameId } }),
      prisma.settlementDraft.count({ where: { gameId } }),
      prisma.settlement.count({ where: { gameId } }),
      prisma.settlementResult.count({ where: { settlement: { gameId } } }),
      prisma.settlementFeeAllocation.count({ where: { settlement: { gameId } } })
    ])).resolves.toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.CSRF_SECRET = randomBytes(32).toString('hex');
    process.env.BOOTSTRAP_ADMIN_USERNAME = `${prefix}-bootstrap`;
    process.env.BOOTSTRAP_ADMIN_NICKNAME = `硬删除根-${runId}`;
    process.env.BOOTSTRAP_ADMIN_PASSWORD = `${randomUUID()}Aa1!`;
    app = await createApp();
    prisma = app.get(PrismaService);
    management = app.get(GameManagementService);
    buyins = app.get(BuyinsService);
    drafts = app.get(SettlementDraftService);
    finalization = app.get(SettlementFinalizationService);
    await app.init();
    monitor = await mariadb.createConnection(connectionOptions());
    superAdmin = await seedUser('super', Role.SUPER_ADMIN);
    admin = await seedUser('admin', Role.ADMIN);
    playerA = await seedUser('player-a', Role.USER);
    playerB = await seedUser('player-b', Role.USER);
  }, 30_000);

  beforeEach(async () => {
    await cleanOwnedGraph();
  });

  afterAll(async () => {
    if (prisma !== undefined) {
      await cleanOwnedGraph();
      const userIds = [superAdmin.id, admin.id, playerA.id, playerB.id];
      await prisma.authSession.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (monitor !== undefined) await monitor.end();
    if (app !== undefined) await app.close();
  }, 30_000);

  it('queues hard delete first so a later buy-in cannot write after deletion', async () => {
    // Break caught: a buy-in commits after the target game and its descendants are deleted.
    const game = await seedActiveGame();
    const blocker = await lockGameOutsidePrisma(game.id);
    let connections: TransactionConnectionProbe | undefined;
    let deletion: ReturnType<GameManagementService['hardDelete']> | undefined;
    const buy: { current: Promise<CapturedOutcome> } = {
      current: Promise.resolve({ status: 'fulfilled' as const, value: undefined as unknown })
    };
    try {
      await expectBlockerTransaction(monitor, blocker);
      connections = observeInteractiveTransactions(prisma);
      connections.setPhase('deleter');
      const startedDeletion = Promise.resolve()
        .then(() => management.hardDelete(game.id, authUser(superAdmin)));
      deletion = startedDeletion;
      const hardDeleteProcessId = await Promise.race([
        connections.waitForConnection('deleter'),
        startedDeletion.then(
          () => { throw new Error('Hard delete completed before the blocker was released'); },
          (error: unknown) => { throw error; }
        )
      ]);
      expect(hardDeleteProcessId).not.toBe(blocker.processId);
      const hardDeleteWait = await Promise.race([
        waitForExactLockQuery(monitor, hardDeleteProcessId, 'games'),
        startedDeletion.then(
          () => { throw new Error('Hard delete completed before its exact row-lock wait was observed'); },
          (error: unknown) => { throw error; }
        )
      ]);
      expectExactLockQuery(hardDeleteWait, hardDeleteProcessId, 'games');
      await expectConnectionRemainsBlocked(monitor, hardDeleteProcessId, 'games');

      connections.setPhase('buyin');
      buy.current = buyins.buy(game.id, authUser(playerA), {
        hands: 1,
        idempotencyKey: `${prefix}-race-buy`
      }).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason })
      );
      const buyinProcessId = await Promise.race([
        connections.waitForConnection('buyin'),
        buy.current.then(() => { throw new Error('Buy-in ended before its transaction was identified'); })
      ]);
      expect(buyinProcessId).not.toBe(blocker.processId);
      expect(buyinProcessId).not.toBe(hardDeleteProcessId);
      const buyinWait = await Promise.race([
        waitForExactLockQuery(monitor, buyinProcessId, 'games'),
        buy.current.then(() => { throw new Error('Buy-in ended before its exact row-lock wait was observed'); })
      ]);
      expectExactLockQuery(buyinWait, buyinProcessId, 'games');
      await expectConnectionRemainsBlocked(monitor, buyinProcessId, 'games');
    } finally {
      try {
        await blocker.release();
      } finally {
        try {
          connections?.restore();
        } finally {
          await Promise.allSettled([
            ...(deletion === undefined ? [] : [deletion]),
            buy.current
          ]);
        }
      }
    }

    if (deletion === undefined) throw new Error('Hard delete was not started');
    await expect(deletion).resolves.toEqual({ deletedGameId: game.id });
    await expect(buy.current).resolves.toMatchObject({
      status: 'rejected', reason: { code: 'NOT_FOUND' }
    });
    await expectNoBusinessRows(game.id);
    await expect(prisma.auditLog.count({
      where: { action: 'GAME_HARD_DELETED', entityId: game.id }
    })).resolves.toBe(1);
    await expect(prisma.auditLog.count({
      where: { action: 'BUYIN_BOUGHT', actorUserId: playerA.id }
    })).resolves.toBe(0);
  }, 30_000);

  it('holds the coordinator while queued so later settlement finalization cannot survive deletion', async () => {
    // Break caught: finalization persists a settlement after hard delete wins the game-row queue.
    const fixture = await seedSettlementFixture();
    const preview = await drafts.get(fixture.game.id, authUser(admin));
    expect(preview.confirmationToken).toEqual(expect.any(String));
    const command = {
      draftVersion: preview.draftVersion,
      settingsVersion: preview.settingsVersion,
      confirmationToken: preview.confirmationToken!
    };
    const blocker = await lockGameOutsidePrisma(fixture.game.id);
    let connections: TransactionConnectionProbe | undefined;
    let deletion: ReturnType<GameManagementService['hardDelete']> | undefined;
    const settlement: { current: Promise<CapturedOutcome> } = {
      current: Promise.resolve({ status: 'fulfilled' as const, value: undefined as unknown })
    };
    try {
      await expectBlockerTransaction(monitor, blocker);
      connections = observeInteractiveTransactions(prisma);
      connections.setPhase('deleter');
      const startedDeletion = Promise.resolve()
        .then(() => management.hardDelete(fixture.game.id, authUser(superAdmin)));
      deletion = startedDeletion;
      const hardDeleteProcessId = await Promise.race([
        connections.waitForConnection('deleter'),
        startedDeletion.then(
          () => { throw new Error('Hard delete completed before the blocker was released'); },
          (error: unknown) => { throw error; }
        )
      ]);
      expect(hardDeleteProcessId).not.toBe(blocker.processId);
      const hardDeleteWait = await Promise.race([
        waitForExactLockQuery(monitor, hardDeleteProcessId, 'games'),
        startedDeletion.then(
          () => { throw new Error('Hard delete completed before its exact row-lock wait was observed'); },
          (error: unknown) => { throw error; }
        )
      ]);
      expectExactLockQuery(hardDeleteWait, hardDeleteProcessId, 'games');
      await expectConnectionRemainsBlocked(monitor, hardDeleteProcessId, 'games');

      connections.setPhase('finalization');
      settlement.current = finalization.finalize(fixture.game.id, authUser(admin), command).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason })
      );
      const finalizationProcessId = await Promise.race([
        connections.waitForConnection('finalization'),
        settlement.current.then(() => {
          throw new Error('Finalization ended before its transaction was identified');
        })
      ]);
      expect(finalizationProcessId).not.toBe(blocker.processId);
      expect(finalizationProcessId).not.toBe(hardDeleteProcessId);
      const finalizationWait = await Promise.race([
        waitForExactLockQuery(monitor, finalizationProcessId, 'system_settings'),
        settlement.current.then(() => {
          throw new Error('Finalization ended before its exact coordinator wait was observed');
        })
      ]);
      expectExactLockQuery(finalizationWait, finalizationProcessId, 'system_settings');
      await expectConnectionRemainsBlocked(monitor, finalizationProcessId, 'system_settings');
    } finally {
      try {
        await blocker.release();
      } finally {
        try {
          connections?.restore();
        } finally {
          await Promise.allSettled([
            ...(deletion === undefined ? [] : [deletion]),
            settlement.current
          ]);
        }
      }
    }

    if (deletion === undefined) throw new Error('Hard delete was not started');
    await expect(deletion).resolves.toEqual({ deletedGameId: fixture.game.id });
    await expect(settlement.current).resolves.toMatchObject({
      status: 'rejected', reason: { code: 'NOT_FOUND' }
    });
    await expectNoBusinessRows(fixture.game.id);
    await expect(prisma.auditLog.count({
      where: { action: 'GAME_HARD_DELETED', entityId: fixture.game.id }
    })).resolves.toBe(1);
    await expect(prisma.auditLog.count({
      where: { action: 'SETTLEMENT_FINALIZED', actorUserId: admin.id }
    })).resolves.toBe(0);
  }, 30_000);
});
