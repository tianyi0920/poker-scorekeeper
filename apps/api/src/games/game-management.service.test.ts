import { Logger } from '@nestjs/common';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { GameStatus, Role } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { GameEventsService } from '../realtime/game-events.service.js';
import type { GameMessagesService } from './game-messages.service.js';
import { GameManagementService } from './game-management.service.js';

const actor: AuthUser = {
  id: 'super-user',
  username: 'super-user',
  nickname: 'Super User',
  role: Role.SUPER_ADMIN,
  mustChangePassword: false,
  avatarKind: 'PRESET',
  avatarValue: 'preset-13'
};

function createTransaction() {
  const now = new Date('2026-08-24T00:00:00.000Z');
  return {
    $queryRaw: vi.fn()
      .mockResolvedValueOnce([{ id: 'singleton' }])
      .mockResolvedValueOnce([{
        id: 'game-1',
        name: 'Game 1',
        handPrice: 100n,
        rakeEnabled: true,
        status: GameStatus.ACTIVE,
        version: 1,
        createdById: actor.id,
        startedAt: now,
        stoppedAt: null,
        completedAt: null,
        settledById: null,
        createdAt: now,
        updatedAt: now
      }])
      .mockResolvedValueOnce([{
        id: actor.id,
        role: Role.SUPER_ADMIN,
        isActive: true,
        deletedAt: null
      }]),
    settlement: { findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => ({ count: 0 })) },
    settlementFeeAllocation: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    settlementResult: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    settlementDraft: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    buyinEvent: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    activePlayerLock: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    gamePlayer: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    game: { delete: vi.fn(async () => ({ id: 'game-1' })) }
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createService(options: {
  transactionFailure?: Error;
  commitFailure?: Error;
  deferCommit?: boolean;
  publishFailure?: Error;
} = {}) {
  const transaction = createTransaction();
  const callbackFinished = deferred();
  const commitGate = deferred();
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) => {
      if (options.transactionFailure !== undefined) throw options.transactionFailure;
      const result = await operation(transaction);
      callbackFinished.resolve();
      if (options.deferCommit) await commitGate.promise;
      if (options.commitFailure !== undefined) throw options.commitFailure;
      return result;
    })
  } as unknown as PrismaService;
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const events = {
    publishDeletedGame: vi.fn(async () => {
      if (options.publishFailure !== undefined) throw options.publishFailure;
    })
  } as unknown as GameEventsService;
  const gameMessages = { clear: vi.fn() } as unknown as GameMessagesService;
  const service = Reflect.construct(
    GameManagementService,
    [prisma, audit, events, gameMessages]
  ) as GameManagementService;
  return {
    service,
    prisma,
    events,
    gameMessages,
    transaction,
    callbackFinished: callbackFinished.promise,
    releaseCommit: commitGate.resolve
  };
}

describe('GameManagementService hard-delete publication', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes exactly once only after the delete transaction resolves', async () => {
    // Break caught: clients are notified before commit or not notified after permanent deletion.
    const fixture = createService();

    await expect(fixture.service.hardDelete('game-1', actor)).resolves.toEqual({
      deletedGameId: 'game-1'
    });

    expect(fixture.events.publishDeletedGame).toHaveBeenCalledExactlyOnceWith('game-1');
    expect(fixture.gameMessages.clear).toHaveBeenCalledExactlyOnceWith('game-1');
    expect(vi.mocked(fixture.gameMessages.clear).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(fixture.events.publishDeletedGame).mock.invocationCallOrder[0]!);
  });

  it('waits for the outer transaction to resolve after its callback finishes before publishing', async () => {
    // Break caught: publishing from inside the callback exposes a deletion before COMMIT succeeds.
    const fixture = createService({ deferCommit: true });
    const deletion = fixture.service.hardDelete('game-1', actor);

    await fixture.callbackFinished;
    try {
      expect(fixture.events.publishDeletedGame).not.toHaveBeenCalled();
      expect(fixture.gameMessages.clear).not.toHaveBeenCalled();
    } finally {
      fixture.releaseCommit();
    }

    await expect(deletion).resolves.toEqual({ deletedGameId: 'game-1' });
    expect(fixture.events.publishDeletedGame).toHaveBeenCalledExactlyOnceWith('game-1');
    expect(fixture.gameMessages.clear).toHaveBeenCalledExactlyOnceWith('game-1');
  });

  it('does not publish when COMMIT rejects after the transaction callback succeeds', async () => {
    // Break caught: a callback-level publish notifies clients even though the outer transaction rolls back.
    const commitFailure = new Error('commit failed');
    const fixture = createService({ commitFailure });
    const deletion = expect(fixture.service.hardDelete('game-1', actor)).rejects.toBe(commitFailure);

    await fixture.callbackFinished;
    await deletion;
    expect(fixture.events.publishDeletedGame).not.toHaveBeenCalled();
    expect(fixture.gameMessages.clear).not.toHaveBeenCalled();
  });

  it('never publishes when the transaction fails', async () => {
    // Break caught: clients leave a game that still exists because deletion rolled back.
    const transactionFailure = new Error('transaction failed');
    const fixture = createService({ transactionFailure });

    await expect(fixture.service.hardDelete('game-1', actor)).rejects.toBe(transactionFailure);

    expect(fixture.events.publishDeletedGame).not.toHaveBeenCalled();
    expect(fixture.gameMessages.clear).not.toHaveBeenCalled();
  });

  it('logs one publication failure without retrying, rolling back, or changing the success response', async () => {
    // Break caught: a best-effort realtime outage turns committed DELETE into HTTP failure or duplicate delivery.
    const publishFailure = new Error('publish failed');
    const fixture = createService({ publishFailure });
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(fixture.service.hardDelete('game-1', actor)).resolves.toEqual({
      deletedGameId: 'game-1'
    });

    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(fixture.events.publishDeletedGame).toHaveBeenCalledExactlyOnceWith('game-1');
    expect(fixture.gameMessages.clear).toHaveBeenCalledExactlyOnceWith('game-1');
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      'Failed to publish hard-deleted game game-1',
      publishFailure.stack
    );
  });
});
