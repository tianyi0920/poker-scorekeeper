import { Inject, Injectable } from '@nestjs/common';
import type {
  AdjustLatestBuyinRequest,
  BuyHandsRequest,
  BuyinEventResponse
} from '@poker/contracts';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { conflict, forbidden, notFound } from '../common/errors/app-error.js';
import {
  BuyinEventType,
  GameStatus,
  Prisma,
  type BuyinEvent
} from '../generated/prisma/client.js';
import { lockGameForUpdate } from '../games/game-lock.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { lockUsersInOrder, requireCurrentActor } from '../users/user-policy.js';
import {
  assertLatestLogicalBuy,
  foldBuyinEvents,
  nextLedgerCreatedAt,
  type LedgerEvent
} from './buyin-ledger.js';

const MAX_SIGNED_BIGINT = 9223372036854775807n;
const MAX_PLAYERS = 12;

const replayInclude = {
  game: { select: { version: true } },
  gamePlayer: { select: { userId: true } }
} satisfies Prisma.BuyinEventInclude;

type ReplayEvent = Prisma.BuyinEventGetPayload<{ include: typeof replayInclude }>;

interface LockedReplayEvent {
  id: string;
  gameId: string;
  gamePlayerId: string;
  playerUserId: string;
  actorUserId: string;
  type: BuyinEventType;
  logicalBuyId: string;
  previousHands: number | bigint | null;
  newHands: number | bigint;
  handsDelta: number | bigint;
  gameVersion: number | bigint;
}

interface ExpectedBinding {
  gameId: string;
  actorUserId: string;
  type: BuyinEventType;
  playerId?: string;
  playerUserId: string;
  requestedHands: number;
}

export interface EffectiveBuyin {
  gamePlayerId: string;
  logicalBuyId: string;
  effectiveHands: number;
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function isRetryableTransactionConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

function eventId(): string {
  return randomBytes(15).toString('hex');
}

function ledgerEvent(event: Pick<BuyinEvent,
  'id' | 'type' | 'logicalBuyId' | 'previousHands' | 'newHands' | 'handsDelta'
>): LedgerEvent {
  return {
    id: event.id,
    type: event.type,
    logicalBuyId: event.logicalBuyId,
    previousHands: event.previousHands,
    newHands: event.newHands,
    handsDelta: event.handsDelta
  };
}

function effectiveHandTotal(events: readonly LedgerEvent[]): number {
  return foldBuyinEvents(events)
    .reduce((total, buy) => total + buy.effectiveHands, 0);
}

function assertAmountInRange(handPrice: bigint, playerHands: number, gameHands: number): void {
  if (
    handPrice * BigInt(playerHands) > MAX_SIGNED_BIGINT ||
    handPrice * BigInt(gameHands) > MAX_SIGNED_BIGINT
  ) {
    throw conflict('BUYIN_AMOUNT_OVERFLOW');
  }
}

function auditEvent(event: BuyinEvent): Record<string, unknown> {
  return {
    id: event.id,
    gameId: event.gameId,
    gamePlayerId: event.gamePlayerId,
    actorUserId: event.actorUserId,
    type: event.type,
    logicalBuyId: event.logicalBuyId,
    previousHands: event.previousHands,
    newHands: event.newHands,
    handsDelta: event.handsDelta
  };
}

@Injectable()
export class BuyinsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService
  ) {}

  async buy(
    gameId: string,
    actor: AuthUser,
    input: BuyHandsRequest
  ): Promise<BuyinEventResponse> {
    const binding: ExpectedBinding = {
      gameId,
      actorUserId: actor.id,
      type: BuyinEventType.BUY,
      playerUserId: actor.id,
      requestedHands: input.hands
    };

    try {
      return await this.writeTransaction(async (transaction) => {
        const replay = await this.findReplay(transaction, input.idempotencyKey);
        if (replay !== null) return this.mapReplay(replay, binding);

        const game = await lockGameForUpdate(transaction, gameId);
        const currentReplay = await this.lockReplay(transaction, input.idempotencyKey);
        if (currentReplay !== null) return this.mapLockedReplay(currentReplay, binding);
        if (game.status !== GameStatus.ACTIVE) throw conflict('GAME_STATE_CONFLICT');

        const users = await lockUsersInOrder(transaction, [actor.id]);
        const currentActor = requireCurrentActor(users, actor.id);
        const existingLock = await transaction.activePlayerLock.findUnique({
          where: { userId: currentActor.id }
        });
        if (existingLock !== null && existingLock.gameId !== gameId) {
          throw conflict('USER_IN_ACTIVE_GAME');
        }

        let player = await transaction.gamePlayer.findUnique({
          where: { gameId_userId: { gameId, userId: currentActor.id } }
        });
        const now = new Date();
        if (player === null) {
          const seated = await transaction.gamePlayer.findMany({
            where: { gameId },
            select: { seatNo: true },
            orderBy: [{ seatNo: 'asc' }, { id: 'asc' }]
          });
          if (seated.length >= MAX_PLAYERS) throw conflict('GAME_PLAYER_LIMIT');
          const usedSeats = new Set(seated.map(({ seatNo }) => seatNo));
          const seatNo = Array.from({ length: MAX_PLAYERS }, (_, index) => index + 1)
            .find((candidate) => !usedSeats.has(candidate));
          if (seatNo === undefined) throw conflict('GAME_PLAYER_LIMIT');
          if (existingLock === null) {
            await transaction.activePlayerLock.create({
              data: { userId: currentActor.id, gameId }
            });
          }
          player = await transaction.gamePlayer.create({
            data: {
              gameId,
              userId: currentActor.id,
              nicknameSnapshot: currentActor.nickname,
              avatarKindSnapshot: currentActor.avatarKind,
              avatarValueSnapshot: currentActor.avatarValue,
              seatNo,
              firstBuyinAt: now
            }
          });
        } else if (existingLock === null) {
          await transaction.activePlayerLock.create({
            data: { userId: currentActor.id, gameId }
          });
        }

        const allEvents = await transaction.buyinEvent.findMany({
          where: { gameId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
        });
        const playerEvents = allEvents.filter(({ gamePlayerId }) => gamePlayerId === player.id);
        const nextPlayerHands = effectiveHandTotal(playerEvents.map(ledgerEvent)) + input.hands;
        const nextGameHands = effectiveHandTotal(allEvents.map(ledgerEvent)) + input.hands;
        assertAmountInRange(game.handPrice, nextPlayerHands, nextGameHands);
        const createdAt = nextLedgerCreatedAt(allEvents.at(-1)?.createdAt, new Date());

        const id = eventId();
        const created = await transaction.buyinEvent.create({
          data: {
            id,
            gameId,
            gamePlayerId: player.id,
            actorUserId: currentActor.id,
            type: BuyinEventType.BUY,
            logicalBuyId: id,
            previousHands: null,
            newHands: input.hands,
            handsDelta: input.hands,
            idempotencyKey: input.idempotencyKey,
            createdAt
          }
        });
        await this.incrementVersion(transaction, game.id, game.version);
        await this.audit.record(transaction, {
          actorUserId: currentActor.id,
          action: 'BUYIN_BOUGHT',
          entityType: 'BUYIN_EVENT',
          entityId: created.id,
          requestId: input.idempotencyKey,
          before: null,
          after: auditEvent(created)
        });
        return this.mapEvent(created, game.version + 1, false);
      });
    } catch (error) {
      return this.recoverConstraint(error, input.idempotencyKey, binding);
    }
  }

  async adjust(
    gameId: string,
    playerId: string,
    actor: AuthUser,
    input: AdjustLatestBuyinRequest
  ): Promise<BuyinEventResponse> {
    const binding: ExpectedBinding = {
      gameId,
      actorUserId: actor.id,
      type: BuyinEventType.ADJUST,
      playerId,
      playerUserId: actor.id,
      requestedHands: input.newHands
    };

    try {
      return await this.writeTransaction(async (transaction) => {
        const replay = await this.findReplay(transaction, input.idempotencyKey);
        if (replay !== null) return this.mapReplay(replay, binding);

        const game = await lockGameForUpdate(transaction, gameId);
        const currentReplay = await this.lockReplay(transaction, input.idempotencyKey);
        if (currentReplay !== null) return this.mapLockedReplay(currentReplay, binding);
        if (game.status !== GameStatus.ACTIVE) throw conflict('GAME_STATE_CONFLICT');

        const player = await transaction.gamePlayer.findUnique({ where: { id: playerId } });
        if (player === null || player.gameId !== gameId) throw notFound('NOT_FOUND');
        if (player.userId !== actor.id) throw forbidden('FORBIDDEN');
        const users = await lockUsersInOrder(transaction, [actor.id, player.userId]);
        const currentActor = requireCurrentActor(users, actor.id);

        const playerEvents = await transaction.buyinEvent.findMany({
          where: { gamePlayerId: player.id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
        });
        const latestBuy = [...playerEvents].reverse()
          .find(({ type }) => type === BuyinEventType.BUY);
        if (latestBuy === undefined) throw conflict('BUYIN_NOT_LATEST');
        assertLatestLogicalBuy(playerEvents.map(ledgerEvent), latestBuy.logicalBuyId);
        const effective = foldBuyinEvents(playerEvents.map(ledgerEvent));
        const latestEffective = effective.find(
          ({ logicalBuyId }) => logicalBuyId === latestBuy.logicalBuyId
        );
        if (latestEffective === undefined) throw conflict('BUYIN_NOT_LATEST');
        const handsDelta = input.newHands - latestEffective.effectiveHands;

        const allEvents = await transaction.buyinEvent.findMany({
          where: { gameId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
        });
        const nextPlayerHands = effectiveHandTotal(playerEvents.map(ledgerEvent)) + handsDelta;
        const nextGameHands = effectiveHandTotal(allEvents.map(ledgerEvent)) + handsDelta;
        assertAmountInRange(game.handPrice, nextPlayerHands, nextGameHands);
        const createdAt = nextLedgerCreatedAt(allEvents.at(-1)?.createdAt, new Date());

        const created = await transaction.buyinEvent.create({
          data: {
            id: eventId(),
            gameId,
            gamePlayerId: player.id,
            actorUserId: currentActor.id,
            type: BuyinEventType.ADJUST,
            logicalBuyId: latestBuy.logicalBuyId,
            previousHands: latestEffective.effectiveHands,
            newHands: input.newHands,
            handsDelta,
            idempotencyKey: input.idempotencyKey,
            createdAt
          }
        });
        await this.incrementVersion(transaction, game.id, game.version);
        await this.audit.record(transaction, {
          actorUserId: currentActor.id,
          action: 'BUYIN_ADJUSTED',
          entityType: 'BUYIN_EVENT',
          entityId: created.id,
          requestId: input.idempotencyKey,
          before: null,
          after: auditEvent(created)
        });
        return this.mapEvent(created, game.version + 1, false);
      });
    } catch (error) {
      return this.recoverConstraint(error, input.idempotencyKey, binding);
    }
  }

  async getEffectiveBuyins(gameId: string): Promise<EffectiveBuyin[]> {
    const events = await this.prisma.buyinEvent.findMany({
      where: { gameId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    });
    const playerByLogicalBuy = new Map(
      events
        .filter(({ type }) => type === BuyinEventType.BUY)
        .map((event) => [event.logicalBuyId, event.gamePlayerId])
    );
    return foldBuyinEvents(events.map(ledgerEvent)).map((buy) => ({
      gamePlayerId: playerByLogicalBuy.get(buy.logicalBuyId)!,
      ...buy
    }));
  }

  async getPlayerBuyInTotal(gamePlayerId: string): Promise<bigint> {
    const player = await this.prisma.gamePlayer.findUnique({
      where: { id: gamePlayerId },
      include: {
        game: { select: { handPrice: true } },
        buyinEvents: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }
      }
    });
    if (player === null) throw notFound('NOT_FOUND');
    const effectiveHands = effectiveHandTotal(player.buyinEvents.map(ledgerEvent));
    assertAmountInRange(player.game.handPrice, effectiveHands, effectiveHands);
    return player.game.handPrice * BigInt(effectiveHands);
  }

  private async incrementVersion(
    transaction: Prisma.TransactionClient,
    gameId: string,
    version: number
  ): Promise<void> {
    const changed = await transaction.game.updateMany({
      where: { id: gameId, status: GameStatus.ACTIVE, version },
      data: { version: { increment: 1 } }
    });
    if (changed.count !== 1) throw conflict('GAME_STATE_CONFLICT');
  }

  private async writeTransaction<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted
        });
      } catch (error) {
        if (!isRetryableTransactionConflict(error) || attempt === maxAttempts) throw error;
      }
    }
    throw new Error('unreachable');
  }

  private async findReplay(
    client: Prisma.TransactionClient | PrismaService,
    idempotencyKey: string
  ): Promise<ReplayEvent | null> {
    return client.buyinEvent.findUnique({
      where: { idempotencyKey },
      include: replayInclude
    });
  }

  private async lockReplay(
    transaction: Prisma.TransactionClient,
    idempotencyKey: string
  ): Promise<LockedReplayEvent | null> {
    const rows = await transaction.$queryRaw<LockedReplayEvent[]>`
      SELECT
        event.id,
        event.game_id AS gameId,
        event.game_player_id AS gamePlayerId,
        player.user_id AS playerUserId,
        event.actor_user_id AS actorUserId,
        event.type,
        event.logical_buy_id AS logicalBuyId,
        event.previous_hands AS previousHands,
        event.new_hands AS newHands,
        event.hands_delta AS handsDelta,
        game.version AS gameVersion
      FROM buyin_events AS event
      INNER JOIN game_players AS player ON player.id = event.game_player_id
      INNER JOIN games AS game ON game.id = event.game_id
      WHERE event.idempotency_key = ${idempotencyKey}
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  private mapReplay(event: ReplayEvent, binding: ExpectedBinding): BuyinEventResponse {
    this.assertBinding(event, event.gamePlayer.userId, binding);
    return this.mapEvent(event, event.game.version, true);
  }

  private mapLockedReplay(
    event: LockedReplayEvent,
    binding: ExpectedBinding
  ): BuyinEventResponse {
    const normalized = {
      ...event,
      previousHands: event.previousHands === null ? null : Number(event.previousHands),
      newHands: Number(event.newHands),
      handsDelta: Number(event.handsDelta)
    };
    this.assertBinding(normalized, event.playerUserId, binding);
    return this.mapEvent(normalized, Number(event.gameVersion), true);
  }

  private assertBinding(
    event: Pick<BuyinEvent,
      'gameId' | 'gamePlayerId' | 'actorUserId' | 'type' | 'newHands'
    >,
    playerUserId: string,
    binding: ExpectedBinding
  ): void {
    if (
      event.gameId !== binding.gameId ||
      event.actorUserId !== binding.actorUserId ||
      event.type !== binding.type ||
      event.newHands !== binding.requestedHands ||
      playerUserId !== binding.playerUserId ||
      (binding.playerId !== undefined && event.gamePlayerId !== binding.playerId)
    ) {
      throw conflict('BUYIN_IDEMPOTENCY_CONFLICT');
    }
  }

  private mapEvent(
    event: Pick<BuyinEvent,
      'id' | 'gameId' | 'gamePlayerId' | 'actorUserId' | 'type' |
      'logicalBuyId' | 'previousHands' | 'newHands' | 'handsDelta'
    >,
    gameVersion: number,
    replayed: boolean
  ): BuyinEventResponse {
    return {
      eventId: event.id,
      gameId: event.gameId,
      playerId: event.gamePlayerId,
      actorUserId: event.actorUserId,
      type: event.type,
      logicalBuyId: event.logicalBuyId,
      previousHands: event.previousHands,
      newHands: event.newHands,
      handsDelta: event.handsDelta,
      replayed,
      gameVersion
    };
  }

  private async recoverConstraint(
    error: unknown,
    idempotencyKey: string,
    binding: ExpectedBinding
  ): Promise<BuyinEventResponse> {
    if (!isUniqueConstraint(error)) throw error;
    const replay = await this.findReplay(this.prisma, idempotencyKey);
    if (replay !== null) return this.mapReplay(replay, binding);
    const activeLock = await this.prisma.activePlayerLock.findUnique({
      where: { userId: binding.playerUserId }
    });
    if (activeLock !== null && activeLock.gameId !== binding.gameId) {
      throw conflict('USER_IN_ACTIVE_GAME');
    }
    throw error;
  }
}
