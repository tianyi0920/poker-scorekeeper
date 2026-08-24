import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateGameRequest,
  CurrentGamesResponse,
  GameSnapshotDto
} from '@poker/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { conflict, notFound } from '../common/errors/app-error.js';
import type { Game, Prisma } from '../generated/prisma/client.js';
import { GameStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GameEventsService } from '../realtime/game-events.service.js';
import { PresenceService } from '../realtime/presence.service.js';
import { defaultSettlementDraftPayload } from '../settlements/settlement-draft.schema.js';
import { lockUsersInOrder, requireCurrentActor } from '../users/user-policy.js';
import {
  assertCanViewGameSnapshot,
  assertGameManager,
  assertGameTransition,
  defaultShanghaiGameName,
  normalizeGameName
} from './game-policy.js';
import { lockGameLifecycleCoordinator } from './game-lifecycle-coordinator.js';
import { lockGameForUpdate } from './game-lock.js';
import { GameMessagesService } from './game-messages.service.js';
import { mapGameSnapshot, type SnapshotGameRecord } from './game-snapshot.mapper.js';

const OPEN_STATUSES = [GameStatus.ACTIVE, GameStatus.SETTLING] as const;

const snapshotInclude = {
  players: true,
  buyinEvents: { include: { actorUser: { select: { nickname: true } } } }
} satisfies Prisma.GameInclude;

function auditGame(game: Game): Record<string, unknown> {
  return {
    id: game.id,
    name: game.name,
    handPrice: game.handPrice.toString(),
    rakeEnabled: game.rakeEnabled,
    status: game.status,
    version: game.version,
    createdById: game.createdById,
    startedAt: game.startedAt,
    stoppedAt: game.stoppedAt,
    completedAt: game.completedAt,
    settledById: game.settledById
  };
}

@Injectable()
export class GamesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(GameEventsService) private readonly events: GameEventsService,
    @Inject(GameMessagesService) private readonly gameMessages: GameMessagesService
  ) {}

  async create(actor: AuthUser, input: CreateGameRequest): Promise<GameSnapshotDto> {
    const snapshot = await this.prisma.$transaction(async (transaction) => {
      await lockGameLifecycleCoordinator(transaction);
      const currentActor = await this.lockAndAuthorizeActor(transaction, actor.id);
      const openCount = await transaction.game.count({
        where: { status: { in: [...OPEN_STATUSES] } }
      });
      if (openCount >= 2) throw conflict('ACTIVE_GAME_LIMIT');

      const now = new Date();
      const name = input.name ?? defaultShanghaiGameName(now);
      const openNames = await transaction.game.findMany({
        where: { status: { in: [...OPEN_STATUSES] } },
        select: { name: true }
      });
      if (openNames.some(({ name: openName }) => (
        normalizeGameName(openName) === normalizeGameName(name)
      ))) {
        throw conflict('ACTIVE_GAME_NAME_TAKEN');
      }

      const created = await transaction.game.create({
        data: {
          name,
          handPrice: BigInt(input.handPrice),
          rakeEnabled: input.rakeEnabled,
          status: GameStatus.ACTIVE,
          startedAt: now,
          createdById: currentActor.id
        }
      });
      await this.audit.record(transaction, {
        actorUserId: currentActor.id,
        action: 'GAME_CREATED_AND_STARTED',
        entityType: 'GAME',
        entityId: created.id,
        before: null,
        after: auditGame(created)
      });
      return this.snapshotIn(transaction, created.id, now);
    });
    await this.publishSafely(snapshot.id);
    return snapshot;
  }

  async start(id: string, actor: AuthUser): Promise<GameSnapshotDto> {
    const snapshot = await this.prisma.$transaction(async (transaction) => {
      await lockGameLifecycleCoordinator(transaction);
      const before = await lockGameForUpdate(transaction, id);
      const currentActor = await this.lockAndAuthorizeActor(transaction, actor.id);
      assertGameTransition(before.status, GameStatus.ACTIVE);

      const openCount = await transaction.game.count({
        where: { status: { in: [...OPEN_STATUSES] } }
      });
      if (openCount >= 2) throw conflict('ACTIVE_GAME_LIMIT');

      const openNames = await transaction.game.findMany({
        where: { status: { in: [...OPEN_STATUSES] } },
        select: { name: true }
      });
      const normalizedName = normalizeGameName(before.name);
      if (openNames.some(({ name }) => normalizeGameName(name) === normalizedName)) {
        throw conflict('ACTIVE_GAME_NAME_TAKEN');
      }

      const now = new Date();
      const changed = await transaction.game.updateMany({
        where: { id, status: GameStatus.DRAFT, version: before.version },
        data: { status: GameStatus.ACTIVE, startedAt: now, version: { increment: 1 } }
      });
      if (changed.count !== 1) throw conflict('GAME_STATE_CONFLICT');
      const after = await transaction.game.findUniqueOrThrow({ where: { id } });
      await this.recordTransition(transaction, currentActor.id, 'GAME_STARTED', before, after);
      return this.snapshotIn(transaction, id, now);
    });
    await this.publishSafely(id);
    return snapshot;
  }

  async beginSettlement(id: string, actor: AuthUser): Promise<GameSnapshotDto> {
    const snapshot = await this.prisma.$transaction(async (transaction) => {
      const before = await lockGameForUpdate(transaction, id);
      const currentActor = await this.lockAndAuthorizeActor(transaction, actor.id);
      assertGameTransition(before.status, GameStatus.SETTLING);
      const now = new Date();
      const changed = await transaction.game.updateMany({
        where: { id, status: GameStatus.ACTIVE, version: before.version },
        data: { status: GameStatus.SETTLING, stoppedAt: now, version: { increment: 1 } }
      });
      if (changed.count !== 1) throw conflict('GAME_STATE_CONFLICT');
      const players = await transaction.gamePlayer.findMany({
        where: { gameId: id },
        select: { id: true },
        orderBy: [{ seatNo: 'asc' }, { id: 'asc' }]
      });
      const initialPayload = defaultSettlementDraftPayload(
        players.map(({ id: playerId }) => playerId)
      );
      await transaction.settlementDraft.create({
        data: {
          gameId: id,
          payload: initialPayload as Prisma.InputJsonValue,
          editorUserId: currentActor.id,
          updatedById: currentActor.id,
          leaseExpiresAt: new Date(now.getTime() + 5 * 60_000)
        }
      });
      const after = await transaction.game.findUniqueOrThrow({ where: { id } });
      await this.recordTransition(
        transaction,
        currentActor.id,
        'GAME_SETTLEMENT_BEGUN',
        before,
        after
      );
      return this.snapshotIn(transaction, id, now);
    });
    this.gameMessages.clear(id);
    await this.publishSafely(id);
    return snapshot;
  }

  async deleteDraft(id: string, actor: AuthUser): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const before = await lockGameForUpdate(transaction, id);
      const currentActor = await this.lockAndAuthorizeActor(transaction, actor.id);
      if (before.status !== GameStatus.DRAFT) throw conflict('GAME_STATE_CONFLICT');
      const [players, locks, purchases, drafts, settlements] = await Promise.all([
        transaction.gamePlayer.count({ where: { gameId: id } }),
        transaction.activePlayerLock.count({ where: { gameId: id } }),
        transaction.buyinEvent.count({ where: { gameId: id } }),
        transaction.settlementDraft.count({ where: { gameId: id } }),
        transaction.settlement.count({ where: { gameId: id } })
      ]);
      if (players + locks + purchases + drafts + settlements > 0) {
        throw conflict('GAME_HAS_RELATIONS');
      }
      const removed = await transaction.game.deleteMany({
        where: { id, status: GameStatus.DRAFT, version: before.version }
      });
      if (removed.count !== 1) throw conflict('GAME_STATE_CONFLICT');
      await this.audit.record(transaction, {
        actorUserId: currentActor.id,
        action: 'GAME_DRAFT_DELETED',
        entityType: 'GAME',
        entityId: before.id,
        before: auditGame(before),
        after: null
      });
    });
  }

  async void(id: string, actor: AuthUser): Promise<GameSnapshotDto> {
    const snapshot = await this.prisma.$transaction(async (transaction) => {
      const before = await lockGameForUpdate(transaction, id);
      const currentActor = await this.lockAndAuthorizeActor(transaction, actor.id);
      assertGameTransition(before.status, GameStatus.VOIDED);
      if (await transaction.buyinEvent.count({ where: { gameId: id } }) > 0) {
        throw conflict('GAME_HAS_BUYINS');
      }
      const now = new Date();
      const changed = await transaction.game.updateMany({
        where: { id, status: GameStatus.ACTIVE, version: before.version },
        data: { status: GameStatus.VOIDED, stoppedAt: now, version: { increment: 1 } }
      });
      if (changed.count !== 1) throw conflict('GAME_STATE_CONFLICT');
      const after = await transaction.game.findUniqueOrThrow({ where: { id } });
      await this.recordTransition(transaction, currentActor.id, 'GAME_VOIDED', before, after);
      return this.snapshotIn(transaction, id, now);
    });
    this.gameMessages.clear(id);
    await this.publishSafely(id);
    return snapshot;
  }

  async current(): Promise<CurrentGamesResponse> {
    const serverNow = new Date();
    const games = await this.prisma.game.findMany({
      where: { status: { in: [...OPEN_STATUSES] } },
      include: snapshotInclude,
      orderBy: [{ startedAt: 'desc' }, { id: 'asc' }]
    });
    return {
      games: await Promise.all(games.map(async (game) => mapGameSnapshot(
        game,
        serverNow,
        await this.presence.list(game.id)
      )))
    };
  }

  async snapshot(id: string, actor: AuthUser): Promise<GameSnapshotDto> {
    const serverNow = new Date();
    const game = await this.prisma.game.findUnique({ where: { id }, include: snapshotInclude });
    if (game === null) throw notFound('NOT_FOUND');
    assertCanViewGameSnapshot(actor, game);
    return mapGameSnapshot(game, serverNow, await this.presence.list(id));
  }

  private async snapshotIn(
    client: Prisma.TransactionClient | PrismaService,
    id: string,
    serverNow: Date
  ): Promise<GameSnapshotDto> {
    const game = await client.game.findUnique({ where: { id }, include: snapshotInclude });
    if (game === null) throw notFound('NOT_FOUND');
    return mapGameSnapshot(
      game as SnapshotGameRecord,
      serverNow,
      await this.presence.list(id, client)
    );
  }

  private async publishSafely(gameId: string): Promise<void> {
    await this.events.publishCommittedGame(gameId).catch(() => undefined);
  }

  private async lockAndAuthorizeActor(
    transaction: Prisma.TransactionClient,
    actorId: string
  ) {
    const locked = await lockUsersInOrder(transaction, [actorId]);
    const currentActor = requireCurrentActor(locked, actorId);
    assertGameManager(currentActor);
    return currentActor;
  }

  private async recordTransition(
    transaction: Prisma.TransactionClient,
    actorUserId: string,
    action: string,
    before: Game,
    after: Game
  ): Promise<void> {
    await this.audit.record(transaction, {
      actorUserId,
      action,
      entityType: 'GAME',
      entityId: before.id,
      before: auditGame(before),
      after: auditGame(after)
    });
  }
}
