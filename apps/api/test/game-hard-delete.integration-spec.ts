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
  queryText: string | null;
}

interface ProcessReadTracker {
  calls: number;
  onRead?(): void;
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
  waitForConnection(phase: TransactionPhase, signal: AbortSignal): Promise<number>;
  restore(): void;
}

interface ObserverScope {
  start<T>(observer: (signal: AbortSignal) => Promise<T>): Promise<T>;
  cancelAndSettle(): Promise<void>;
}

interface ConnectionWaiter {
  signal: AbortSignal;
  onAbort(): void;
  resolve(processId: number): void;
  reject(error: unknown): void;
}

type CapturedOutcome =
  | { status: 'fulfilled'; value: unknown }
  | { status: 'rejected'; reason: unknown };

function observerAbortError(description: string): Error {
  const error = new Error(`Cancelled waiting for ${description}`);
  error.name = 'AbortError';
  return error;
}

function throwIfObserverAborted(signal: AbortSignal | undefined, description: string): void {
  if (signal?.aborted === true) throw observerAbortError(description);
}

function createObserverScope(): ObserverScope {
  const controllers: AbortController[] = [];
  const observers: Promise<unknown>[] = [];
  return {
    start<T>(observer: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const controller = new AbortController();
      controllers.push(controller);
      const promise = observer(controller.signal);
      observers.push(promise);
      return promise;
    },
    async cancelAndSettle(): Promise<void> {
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(observers);
    }
  };
}

function captureOutcome<T>(promise: Promise<T>): Promise<CapturedOutcome> {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason })
  );
}

async function observeBeforeBusinessSettles<T>(
  observer: Promise<T>,
  business: Promise<CapturedOutcome>,
  description: string
): Promise<T> {
  const winner = await Promise.race([
    observer.then(
      (value) => ({ kind: 'observer' as const, value }),
      (reason: unknown) => ({ kind: 'observer-error' as const, reason })
    ),
    business.then((outcome) => ({ kind: 'business' as const, outcome }))
  ]);
  if (winner.kind === 'observer') return winner.value;
  if (winner.kind === 'observer-error') throw winner.reason;
  if (winner.outcome.status === 'rejected') throw winner.outcome.reason;
  throw new Error(`${description} completed before the observation`);
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
  timeoutMilliseconds = 10_000,
  signal?: AbortSignal
): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    throwIfObserverAborted(signal, description);
    const result = await read();
    throwIfObserverAborted(signal, description);
    if (result !== null) return result;
  }
  throwIfObserverAborted(signal, description);
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
  const waiters = new Map<TransactionPhase, Set<ConnectionWaiter>>();
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
        const phaseWaiters = waiters.get(phase);
        if (phaseWaiters !== undefined) {
          waiters.delete(phase);
          for (const waiter of phaseWaiters) {
            waiter.signal.removeEventListener('abort', waiter.onAbort);
            waiter.resolve(processId);
          }
        }
      }
      return operation(transaction);
    }, options);
  });
  return {
    setPhase(phase) {
      currentPhase = phase;
    },
    waitForConnection(phase, signal) {
      if (signal.aborted) return Promise.reject(observerAbortError(`${phase} connection`));
      const processId = observed.get(phase);
      if (processId !== undefined) return Promise.resolve(processId);
      return new Promise<number>((resolve, reject) => {
        const waiter: ConnectionWaiter = {
          signal,
          resolve,
          reject,
          onAbort() {
            const phaseWaiters = waiters.get(phase);
            phaseWaiters?.delete(waiter);
            if (phaseWaiters?.size === 0) waiters.delete(phase);
            signal.removeEventListener('abort', waiter.onAbort);
            reject(observerAbortError(`${phase} connection`));
          }
        };
        const phaseWaiters = waiters.get(phase) ?? new Set<ConnectionWaiter>();
        phaseWaiters.add(waiter);
        waiters.set(phase, phaseWaiters);
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      });
    },
    restore() {
      for (const [phase, phaseWaiters] of waiters) {
        waiters.delete(phase);
        for (const waiter of phaseWaiters) {
          waiter.signal.removeEventListener('abort', waiter.onAbort);
          waiter.reject(observerAbortError(`${phase} connection probe restored`));
        }
      }
      transactionSpy.mockRestore();
    }
  };
}

async function readProcess(
  monitor: Connection,
  processId: number,
  tracker: ProcessReadTracker
): Promise<ProcessRow | null> {
  tracker.calls += 1;
  tracker.onRead?.();
  const rows = await monitor.query<ProcessRow[]>(`
    SELECT ID AS processId, INFO AS queryText
    FROM information_schema.PROCESSLIST
    WHERE DB = ? AND ID = ?
  `, [databaseName, processId]);
  return rows[0] ?? null;
}

async function waitForExactLockQuery(
  monitor: Connection,
  processId: number,
  tableName: 'games' | 'system_settings',
  tracker: ProcessReadTracker,
  signal: AbortSignal
): Promise<ProcessRow> {
  return waitForCondition(
    `connection ${processId} executing ${tableName} FOR UPDATE`,
    async () => {
      const row = await readProcess(monitor, processId, tracker);
      const normalized = row?.queryText?.toLowerCase() ?? '';
      return row !== null && normalized.includes(`from ${tableName}`)
        && normalized.includes('for update')
        ? row
        : null;
    },
    10_000,
    signal
  );
}

async function expectBlockerTransaction(
  monitor: Connection,
  blocker: GameBlocker,
  tracker: ProcessReadTracker,
  signal: AbortSignal
): Promise<void> {
  const process = await waitForCondition(
    `blocker connection ${blocker.processId}`,
    () => readProcess(monitor, blocker.processId, tracker),
    10_000,
    signal
  );
  expect(Number(process.processId)).toBe(blocker.processId);
}

function expectExactLockQuery(
  row: ProcessRow,
  processId: number,
  tableName: 'games' | 'system_settings'
): void {
  expect(Number(row.processId)).toBe(processId);
  const normalized = row.queryText?.toLowerCase() ?? '';
  expect(normalized).toContain(`from ${tableName}`);
  expect(normalized).toContain('for update');
}

async function expectConnectionRemainsBlocked(
  monitor: Connection,
  processId: number,
  tableName: 'games' | 'system_settings',
  tracker: ProcessReadTracker
): Promise<void> {
  await monitor.query('SELECT 1');
  const row = await readProcess(monitor, processId, tracker);
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
    let firstCancellationRead!: () => void;
    const cancellationReadStarted = new Promise<void>((resolve) => {
      firstCancellationRead = resolve;
    });
    const cancellationReads: ProcessReadTracker = {
      calls: 0,
      onRead: firstCancellationRead
    };
    const cancellationObservers = createObserverScope();
    const canceledProcessObserver = cancellationObservers.start((signal) => waitForExactLockQuery(
      monitor,
      -1,
      'games',
      cancellationReads,
      signal
    ));
    await cancellationReadStarted;
    await cancellationObservers.cancelAndSettle();
    await expect(canceledProcessObserver).rejects.toMatchObject({ name: 'AbortError' });
    const readsAfterCancellation = cancellationReads.calls;
    await monitor.query('SELECT 1');
    expect(cancellationReads.calls).toBe(readsAfterCancellation);

    const cancellationProbe = observeInteractiveTransactions(prisma);
    const probeObservers = createObserverScope();
    const canceledProbeObserver = probeObservers.start((signal) => (
      cancellationProbe.waitForConnection('buyin', signal)
    ));
    try {
      await probeObservers.cancelAndSettle();
      await expect(canceledProbeObserver).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      await probeObservers.cancelAndSettle();
      cancellationProbe.restore();
    }

    const game = await seedActiveGame();
    const blocker = await lockGameOutsidePrisma(game.id);
    const observers = createObserverScope();
    const processReads: ProcessReadTracker = { calls: 0 };
    let connections: TransactionConnectionProbe | undefined;
    let deletion: ReturnType<GameManagementService['hardDelete']> | undefined;
    let deletionOutcome: Promise<CapturedOutcome> | undefined;
    const buy: { current: Promise<CapturedOutcome> } = {
      current: Promise.resolve({ status: 'fulfilled' as const, value: undefined as unknown })
    };
    try {
      const blockerObserver = observers.start((signal) => expectBlockerTransaction(
        monitor,
        blocker,
        processReads,
        signal
      ));
      await blockerObserver;
      connections = observeInteractiveTransactions(prisma);
      connections.setPhase('deleter');
      const startedDeletion = Promise.resolve()
        .then(() => management.hardDelete(game.id, authUser(superAdmin)));
      deletion = startedDeletion;
      const startedDeletionOutcome = captureOutcome(startedDeletion);
      deletionOutcome = startedDeletionOutcome;
      const deletionConnectionObserver = observers.start((signal) => (
        connections!.waitForConnection('deleter', signal)
      ));
      const hardDeleteProcessId = await observeBeforeBusinessSettles(
        deletionConnectionObserver,
        startedDeletionOutcome,
        'Hard delete connection identification'
      );
      expect(hardDeleteProcessId).not.toBe(blocker.processId);
      const hardDeleteLockObserver = observers.start((signal) => waitForExactLockQuery(
        monitor,
        hardDeleteProcessId,
        'games',
        processReads,
        signal
      ));
      const hardDeleteWait = await observeBeforeBusinessSettles(
        hardDeleteLockObserver,
        startedDeletionOutcome,
        'Hard delete exact row-lock wait'
      );
      expectExactLockQuery(hardDeleteWait, hardDeleteProcessId, 'games');
      await expectConnectionRemainsBlocked(
        monitor,
        hardDeleteProcessId,
        'games',
        processReads
      );

      connections.setPhase('buyin');
      buy.current = captureOutcome(buyins.buy(game.id, authUser(playerA), {
        hands: 1,
        idempotencyKey: `${prefix}-race-buy`
      }));
      const buyinConnectionObserver = observers.start((signal) => (
        connections!.waitForConnection('buyin', signal)
      ));
      const buyinProcessId = await observeBeforeBusinessSettles(
        buyinConnectionObserver,
        buy.current,
        'Buy-in connection identification'
      );
      expect(buyinProcessId).not.toBe(blocker.processId);
      expect(buyinProcessId).not.toBe(hardDeleteProcessId);
      const buyinLockObserver = observers.start((signal) => waitForExactLockQuery(
        monitor,
        buyinProcessId,
        'games',
        processReads,
        signal
      ));
      const buyinWait = await observeBeforeBusinessSettles(
        buyinLockObserver,
        buy.current,
        'Buy-in exact row-lock wait'
      );
      expectExactLockQuery(buyinWait, buyinProcessId, 'games');
      await expectConnectionRemainsBlocked(monitor, buyinProcessId, 'games', processReads);
    } finally {
      try {
        await observers.cancelAndSettle();
        const readsAfterObserverSettlement = processReads.calls;
        await monitor.query('SELECT 1');
        expect(processReads.calls).toBe(readsAfterObserverSettlement);
      } finally {
        try {
          await blocker.release();
        } finally {
          try {
            await Promise.allSettled([
              ...(deletionOutcome === undefined ? [] : [deletionOutcome]),
              buy.current
            ]);
          } finally {
            connections?.restore();
          }
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
    const observers = createObserverScope();
    const processReads: ProcessReadTracker = { calls: 0 };
    let connections: TransactionConnectionProbe | undefined;
    let deletion: ReturnType<GameManagementService['hardDelete']> | undefined;
    let deletionOutcome: Promise<CapturedOutcome> | undefined;
    const settlement: { current: Promise<CapturedOutcome> } = {
      current: Promise.resolve({ status: 'fulfilled' as const, value: undefined as unknown })
    };
    try {
      const blockerObserver = observers.start((signal) => expectBlockerTransaction(
        monitor,
        blocker,
        processReads,
        signal
      ));
      await blockerObserver;
      connections = observeInteractiveTransactions(prisma);
      connections.setPhase('deleter');
      const startedDeletion = Promise.resolve()
        .then(() => management.hardDelete(fixture.game.id, authUser(superAdmin)));
      deletion = startedDeletion;
      const startedDeletionOutcome = captureOutcome(startedDeletion);
      deletionOutcome = startedDeletionOutcome;
      const deletionConnectionObserver = observers.start((signal) => (
        connections!.waitForConnection('deleter', signal)
      ));
      const hardDeleteProcessId = await observeBeforeBusinessSettles(
        deletionConnectionObserver,
        startedDeletionOutcome,
        'Hard delete connection identification'
      );
      expect(hardDeleteProcessId).not.toBe(blocker.processId);
      const hardDeleteLockObserver = observers.start((signal) => waitForExactLockQuery(
        monitor,
        hardDeleteProcessId,
        'games',
        processReads,
        signal
      ));
      const hardDeleteWait = await observeBeforeBusinessSettles(
        hardDeleteLockObserver,
        startedDeletionOutcome,
        'Hard delete exact row-lock wait'
      );
      expectExactLockQuery(hardDeleteWait, hardDeleteProcessId, 'games');
      await expectConnectionRemainsBlocked(
        monitor,
        hardDeleteProcessId,
        'games',
        processReads
      );

      connections.setPhase('finalization');
      settlement.current = captureOutcome(
        finalization.finalize(fixture.game.id, authUser(admin), command)
      );
      const finalizationConnectionObserver = observers.start((signal) => (
        connections!.waitForConnection('finalization', signal)
      ));
      const finalizationProcessId = await observeBeforeBusinessSettles(
        finalizationConnectionObserver,
        settlement.current,
        'Finalization connection identification'
      );
      expect(finalizationProcessId).not.toBe(blocker.processId);
      expect(finalizationProcessId).not.toBe(hardDeleteProcessId);
      const finalizationLockObserver = observers.start((signal) => waitForExactLockQuery(
        monitor,
        finalizationProcessId,
        'system_settings',
        processReads,
        signal
      ));
      const finalizationWait = await observeBeforeBusinessSettles(
        finalizationLockObserver,
        settlement.current,
        'Finalization exact coordinator wait'
      );
      expectExactLockQuery(finalizationWait, finalizationProcessId, 'system_settings');
      await expectConnectionRemainsBlocked(
        monitor,
        finalizationProcessId,
        'system_settings',
        processReads
      );
    } finally {
      try {
        await observers.cancelAndSettle();
        const readsAfterObserverSettlement = processReads.calls;
        await monitor.query('SELECT 1');
        expect(processReads.calls).toBe(readsAfterObserverSettlement);
      } finally {
        try {
          await blocker.release();
        } finally {
          try {
            await Promise.allSettled([
              ...(deletionOutcome === undefined ? [] : [deletionOutcome]),
              settlement.current
            ]);
          } finally {
            connections?.restore();
          }
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
