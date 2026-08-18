import { Inject, Injectable } from '@nestjs/common';
import {
  canonicalPublicIdSchema,
  formatMoney,
  type FinalizeSettlementRequest,
  type SettlementDetailDto,
  type SettlementDraftPayload
} from '@poker/contracts';
import { calculateSettlement } from '@poker/settlement';
import { AuditService } from '../audit/audit.service.js';
import { foldBuyinEvents } from '../buyins/buyin-ledger.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { badRequest, conflict, conflictWithDetails } from '../common/errors/app-error.js';
import { GameStatus, Prisma } from '../generated/prisma/client.js';
import { lockGameForUpdate } from '../games/game-lock.js';
import { assertGameManager } from '../games/game-policy.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GameEventsService } from '../realtime/game-events.service.js';
import { lockUsersInOrder, requireCurrentActor } from '../users/user-policy.js';
import { matchesSettlementConfirmation, settlementConfirmationToken } from './settlement-confirmation.js';
import { parseStoredSettlementDraftPayload } from './settlement-draft.schema.js';
import { type PreviewContext } from './settlement-preview.mapper.js';
import { persistSettlement } from './settlement-persistence.mapper.js';

const SETTINGS_ID = 'singleton';

interface LockedId { id: string }

function assertCanonicalGameId(gameId: string): void {
  if (!canonicalPublicIdSchema.safeParse(gameId).success) throw badRequest('VALIDATION_ERROR');
}

function isRetryable(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

function toOutput(context: PreviewContext, payload: SettlementDraftPayload) {
  const eventsByPlayer = new Map<string, typeof context.buyinEvents>();
  for (const event of context.buyinEvents) {
    const events = eventsByPlayer.get(event.gamePlayerId) ?? [];
    events.push(event);
    eventsByPlayer.set(event.gamePlayerId, events);
  }
  const players = [...context.players]
    .sort((left, right) => left.seatNo - right.seatNo || left.id.localeCompare(right.id))
    .map((player) => {
      const cashOut = payload.cashOutByPlayerId[player.id];
      if (cashOut === undefined || cashOut === '') throw conflict('SETTLEMENT_PREVIEW_CONFLICT');
      const hands = foldBuyinEvents((eventsByPlayer.get(player.id) ?? [])
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
        .map((event) => ({
          id: event.id,
          type: event.type,
          logicalBuyId: event.logicalBuyId,
          previousHands: event.previousHands,
          newHands: event.newHands,
          handsDelta: event.handsDelta
        })))
        .reduce((sum, event) => sum + event.effectiveHands, 0);
      return {
        playerId: player.id,
        seatNo: player.seatNo,
        buyIn: context.game.handPrice * BigInt(hands),
        cashOut: BigInt(cashOut),
        rakeEnabled: player.user.rakeEnabled
      };
    });
  const buyIn = players.reduce((sum, player) => sum + player.buyIn, 0n);
  const cashOut = players.reduce((sum, player) => sum + player.cashOut, 0n);
  if (players.length === 0 || buyIn !== cashOut) throw conflict('SETTLEMENT_PREVIEW_CONFLICT');
  return calculateSettlement({
    players,
    gameRakeEnabled: context.game.rakeEnabled,
    rakeThreshold: context.settings.rakeThreshold,
    rakeBps: context.settings.rakeBps,
    roomFee: BigInt(payload.roomFee),
    roomPayerIds: payload.roomPayerIds,
    otherFee: BigInt(payload.otherFee),
    otherPayerIds: payload.otherPayerIds
  });
}

function detailDto(
  context: PreviewContext,
  payload: SettlementDraftPayload,
  output: ReturnType<typeof toOutput>,
  completedAt: Date,
  settledByNickname: string
): SettlementDetailDto {
  const playerById = new Map(context.players.map((player) => [player.id, player]));
  const startedAt = context.game.startedAt;
  const stoppedAt = context.game.stoppedAt;
  if (startedAt === null || stoppedAt === null) throw conflict('GAME_STATE_CONFLICT');
  return {
    totals: {
      buyIn: formatMoney(output.buyInTotal),
      cashOut: formatMoney(output.cashOutTotal),
      roomFee: formatMoney(output.roomFeeTotal),
      otherFee: formatMoney(output.otherFeeTotal),
      rake: formatMoney(output.rakeTotal),
      final: formatMoney(output.finalTotal)
    },
    players: output.results.map((result) => {
      const player = playerById.get(result.playerId)!;
      return {
        playerId: result.playerId,
        nickname: player.nicknameSnapshot,
        avatarKind: player.avatarKindSnapshot,
        avatarValue: player.avatarValueSnapshot,
        seatNo: player.seatNo,
        buyIn: formatMoney(result.buyIn),
        cashOut: formatMoney(result.cashOut),
        rawProfit: formatMoney(result.rawProfit),
        roomFeeShare: formatMoney(result.roomFeeShare),
        otherFeeShare: formatMoney(result.otherFeeShare),
        afterFeeProfit: formatMoney(result.afterFeeProfit),
        rakeEligible: result.rakeEligible,
        rakeAmount: formatMoney(result.rakeAmount),
        finalAmount: formatMoney(result.finalAmount)
      };
    }),
    game: {
      id: context.game.id,
      name: context.game.name,
      startedAt: startedAt.toISOString(),
      stoppedAt: stoppedAt.toISOString(),
      durationSeconds: Math.max(0, Math.floor((stoppedAt.getTime() - startedAt.getTime()) / 1000))
    },
    completedAt: completedAt.toISOString(),
    settledByNickname,
    otherFeeNote: payload.otherFeeNote,
    immutable: true
  };
}

@Injectable()
export class SettlementFinalizationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(GameEventsService) private readonly events: GameEventsService
  ) {}

  async finalize(
    gameId: string,
    actor: AuthUser,
    command: FinalizeSettlementRequest
  ): Promise<SettlementDetailDto> {
    assertCanonicalGameId(gameId);
    const result = await this.writeTransaction(async (transaction) => {
      await transaction.$queryRaw<LockedId[]>`
        SELECT id FROM system_settings WHERE id = ${SETTINGS_ID} FOR UPDATE
      `;
      const settings = await transaction.systemSetting.findUniqueOrThrow({ where: { id: SETTINGS_ID } });
      const game = await lockGameForUpdate(transaction, gameId);
      const draft = await this.lockDraft(transaction, gameId);
      await transaction.$queryRaw<LockedId[]>`
        SELECT id FROM game_players WHERE game_id = ${gameId} ORDER BY id FOR UPDATE
      `;
      await transaction.$queryRaw<LockedId[]>`
        SELECT id FROM buyin_events WHERE game_id = ${gameId} ORDER BY id FOR UPDATE
      `;
      const players = await transaction.gamePlayer.findMany({
        where: { gameId },
        include: { user: { select: { rakeEnabled: true } } },
        orderBy: [{ seatNo: 'asc' }, { id: 'asc' }]
      });
      const users = await lockUsersInOrder(transaction, [actor.id, ...players.map((player) => player.userId)]);
      const currentActor = requireCurrentActor(users, actor.id);
      assertGameManager(currentActor);
      if (game.status !== GameStatus.SETTLING) throw conflict('GAME_STATE_CONFLICT');
      if (draft.editorUserId !== currentActor.id) throw conflict('DRAFT_EDITOR_CONFLICT');
      if (draft.version !== command.draftVersion) {
        throw conflictWithDetails('DRAFT_VERSION_CONFLICT', { currentDraftVersion: draft.version });
      }
      if (settings.version !== command.settingsVersion) {
        throw conflictWithDetails('SETTINGS_VERSION_CONFLICT', { currentSettingsVersion: settings.version });
      }
      const payload = parseStoredSettlementDraftPayload(draft.payload);
      const events = await transaction.buyinEvent.findMany({
        where: { gameId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
      });
      const context: PreviewContext = { game, players, buyinEvents: events, settings };
      const expectedToken = settlementConfirmationToken(context, payload, draft.version);
      if (!matchesSettlementConfirmation(expectedToken, command.confirmationToken)) {
        throw conflictWithDetails('SETTLEMENT_PREVIEW_CONFLICT', { refreshRequired: true });
      }
      const output = toOutput(context, payload);
      const completedAt = new Date();
      const settlement = await persistSettlement(transaction, context, payload, output, currentActor.id, completedAt);
      const changed = await transaction.game.updateMany({
        where: { id: game.id, status: GameStatus.SETTLING, version: game.version },
        data: {
          status: GameStatus.COMPLETED,
          completedAt,
          settledById: currentActor.id,
          version: { increment: 1 }
        }
      });
      if (changed.count !== 1) throw conflict('GAME_STATE_CONFLICT');
      await transaction.activePlayerLock.deleteMany({ where: { gameId: game.id } });
      await this.audit.record(transaction, {
        actorUserId: currentActor.id,
        action: 'SETTLEMENT_FINALIZED',
        entityType: 'SETTLEMENT',
        entityId: settlement.id,
        before: null,
        after: { gameId: game.id, draftVersion: draft.version, settingsVersion: settings.version }
      });
      return detailDto(context, payload, output, completedAt, currentActor.nickname);
    });
    await this.events.publishCommittedGame(gameId).catch(() => undefined);
    return result;
  }

  private async lockDraft(transaction: Prisma.TransactionClient, gameId: string) {
    const locked = await transaction.$queryRaw<LockedId[]>`
      SELECT id FROM settlement_drafts WHERE game_id = ${gameId} FOR UPDATE
    `;
    if (locked[0] === undefined) throw conflict('GAME_STATE_CONFLICT');
    return transaction.settlementDraft.findUniqueOrThrow({ where: { gameId } });
  }

  private async writeTransaction<T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable
        });
      } catch (error) {
        if (!isRetryable(error) || attempt === 3) throw error;
      }
    }
    throw new Error('unreachable');
  }
}
