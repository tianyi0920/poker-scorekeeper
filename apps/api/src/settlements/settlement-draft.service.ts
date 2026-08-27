import { Inject, Injectable } from '@nestjs/common';
import {
  canonicalPublicIdSchema,
  type SaveSettlementDraftRequest,
  type SettlementDraftDto,
  type SettlementDraftPayload,
  type SettlementPreviewDto
} from '@poker/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import {
  badRequest,
  conflict,
  conflictWithDetails,
  notFound
} from '../common/errors/app-error.js';
import { GameStatus, Prisma, type SettlementDraft } from '../generated/prisma/client.js';
import { lockGameForUpdate } from '../games/game-lock.js';
import {
  assertCanManageGameLifecycle,
  assertCanViewGameSnapshot,
  assertGameManager
} from '../games/game-policy.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GameEventsService } from '../realtime/game-events.service.js';
import { lockUsersInOrder, requireCurrentActor } from '../users/user-policy.js';
import {
  assertExactDraftPlayerSet,
  parseStoredSettlementDraftPayload
} from './settlement-draft.schema.js';
import {
  buildSettlementPreview,
  defaultFeePayersOnFirstBalance,
  type PreviewContext
} from './settlement-preview.mapper.js';

const SETTINGS_ID = 'singleton';
const LEASE_DURATION_MS = 5 * 60_000;

const previewGameInclude = {
  players: {
    include: { user: { select: { rakeEnabled: true } } },
    orderBy: [{ seatNo: 'asc' as const }, { id: 'asc' as const }]
  },
  buyinEvents: { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] }
} satisfies Prisma.GameInclude;

const draftInclude = {
  editorUser: { select: { nickname: true } }
} satisfies Prisma.SettlementDraftInclude;

type DraftWithEditor = Prisma.SettlementDraftGetPayload<{ include: typeof draftInclude }>;

interface LockedDraftId {
  id: string;
}

function assertCanonicalGameId(gameId: string): void {
  if (!canonicalPublicIdSchema.safeParse(gameId).success) throw badRequest('VALIDATION_ERROR');
}

function auditDraft(draft: SettlementDraft, payload: SettlementDraftPayload) {
  return {
    id: draft.id,
    gameId: draft.gameId,
    version: draft.version,
    editorUserId: draft.editorUserId,
    leaseExpiresAt: draft.leaseExpiresAt,
    updatedById: draft.updatedById,
    payload
  };
}

@Injectable()
export class SettlementDraftService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(GameEventsService) private readonly events: GameEventsService
  ) {}

  async get(gameId: string, actor: AuthUser): Promise<SettlementDraftDto> {
    assertCanonicalGameId(gameId);
    return this.prisma.$transaction(async (transaction) => {
      const context = await this.loadPreviewContext(transaction, gameId);
      assertCanViewGameSnapshot(actor, {
        status: context.game.status,
        players: context.players
      });
      const draft = await transaction.settlementDraft.findUnique({
        where: { gameId },
        include: draftInclude
      });
      if (draft === null) throw notFound('NOT_FOUND');
      return this.toDraftDto(actor, draft, context);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async save(
    gameId: string,
    actor: AuthUser,
    command: SaveSettlementDraftRequest
  ): Promise<SettlementDraftDto> {
    assertCanonicalGameId(gameId);
    const result = await this.prisma.$transaction(async (transaction) => {
      const game = await lockGameForUpdate(transaction, gameId);
      if (game.status !== GameStatus.SETTLING) throw conflict('GAME_STATE_CONFLICT');
      const before = await this.lockDraft(transaction, gameId);
      const users = await lockUsersInOrder(transaction, [actor.id]);
      const currentActor = requireCurrentActor(users, actor.id);
      assertCanManageGameLifecycle(currentActor, game);
      const context = await this.loadPreviewContext(transaction, gameId);
      const previousPayload = parseStoredSettlementDraftPayload(before.payload);
      assertExactDraftPlayerSet(command.payload, context.players.map(({ id }) => id));

      if (before.editorUserId !== currentActor.id) {
        throw conflictWithDetails('DRAFT_EDITOR_CONFLICT', {
          latest: this.toDraftDto(currentActor, before, context)
        });
      }
      if (before.version !== command.version) {
        throw conflictWithDetails('DRAFT_VERSION_CONFLICT', {
          latest: this.toDraftDto(currentActor, before, context)
        });
      }

      const payload = defaultFeePayersOnFirstBalance(context, previousPayload, command.payload);
      const now = new Date();
      const saved = await transaction.settlementDraft.updateMany({
        where: {
          gameId,
          version: command.version,
          editorUserId: currentActor.id
        },
        data: {
          payload: payload as Prisma.InputJsonValue,
          version: { increment: 1 },
          leaseExpiresAt: new Date(now.getTime() + LEASE_DURATION_MS),
          updatedById: currentActor.id
        }
      });
      if (saved.count !== 1) {
        const latest = await transaction.settlementDraft.findUniqueOrThrow({
          where: { gameId },
          include: draftInclude
        });
        throw conflictWithDetails('DRAFT_VERSION_CONFLICT', {
          latest: this.toDraftDto(currentActor, latest, context)
        });
      }
      const after = await transaction.settlementDraft.findUniqueOrThrow({
        where: { gameId },
        include: draftInclude
      });
      await this.audit.record(transaction, {
        actorUserId: currentActor.id,
        action: 'SETTLEMENT_DRAFT_UPDATED',
        entityType: 'SETTLEMENT_DRAFT',
        entityId: after.id,
        before: auditDraft(before, previousPayload),
        after: auditDraft(after, payload)
      });
      return this.toDraftDto(currentActor, after, context);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    await this.publishSafely(gameId);
    return result;
  }

  async takeover(gameId: string, actor: AuthUser): Promise<SettlementDraftDto> {
    assertCanonicalGameId(gameId);
    const result = await this.prisma.$transaction(async (transaction) => {
      const game = await lockGameForUpdate(transaction, gameId);
      if (game.status !== GameStatus.SETTLING) throw conflict('GAME_STATE_CONFLICT');
      const before = await this.lockDraft(transaction, gameId);
      const users = await lockUsersInOrder(transaction, [actor.id]);
      const currentActor = requireCurrentActor(users, actor.id);
      assertGameManager(currentActor);
      const context = await this.loadPreviewContext(transaction, gameId);
      const beforePayload = parseStoredSettlementDraftPayload(before.payload);
      const now = new Date();
      if (before.editorUserId === currentActor.id || before.leaseExpiresAt.getTime() > now.getTime()) {
        throw conflictWithDetails('DRAFT_LEASE_ACTIVE', {
          latest: this.toDraftDto(currentActor, before, context)
        });
      }
      const changed = await transaction.settlementDraft.updateMany({
        where: {
          gameId,
          version: before.version,
          editorUserId: before.editorUserId,
          leaseExpiresAt: { lte: now }
        },
        data: {
          editorUserId: currentActor.id,
          updatedById: currentActor.id,
          leaseExpiresAt: new Date(now.getTime() + LEASE_DURATION_MS),
          version: { increment: 1 }
        }
      });
      if (changed.count !== 1) {
        const latest = await transaction.settlementDraft.findUniqueOrThrow({
          where: { gameId },
          include: draftInclude
        });
        throw conflictWithDetails('DRAFT_LEASE_ACTIVE', {
          latest: this.toDraftDto(currentActor, latest, context)
        });
      }
      const after = await transaction.settlementDraft.findUniqueOrThrow({
        where: { gameId },
        include: draftInclude
      });
      await this.audit.record(transaction, {
        actorUserId: currentActor.id,
        action: 'SETTLEMENT_TAKEN_OVER',
        entityType: 'SETTLEMENT_DRAFT',
        entityId: after.id,
        before: auditDraft(before, beforePayload),
        after: auditDraft(after, beforePayload)
      });
      return this.toDraftDto(currentActor, after, context);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    await this.publishSafely(gameId);
    return result;
  }

  async preview(
    gameId: string,
    actor: AuthUser,
    payload: SettlementDraftPayload
  ): Promise<SettlementPreviewDto> {
    assertCanonicalGameId(gameId);
    return this.prisma.$transaction(async (transaction) => {
      const context = await this.loadPreviewContext(transaction, gameId);
      assertCanViewGameSnapshot(actor, {
        status: context.game.status,
        players: context.players
      });
      assertExactDraftPlayerSet(payload, context.players.map(({ id }) => id));
      const draft = await transaction.settlementDraft.findUnique({ where: { gameId } });
      if (draft === null) throw notFound('NOT_FOUND');
      return buildSettlementPreview(context, payload, draft.version);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  private async lockDraft(
    transaction: Prisma.TransactionClient,
    gameId: string
  ): Promise<DraftWithEditor> {
    const locked = await transaction.$queryRaw<LockedDraftId[]>`
      SELECT id FROM settlement_drafts WHERE game_id = ${gameId} FOR UPDATE
    `;
    if (locked[0] === undefined) throw notFound('NOT_FOUND');
    return transaction.settlementDraft.findUniqueOrThrow({
      where: { gameId },
      include: draftInclude
    });
  }

  private async loadPreviewContext(
    transaction: Prisma.TransactionClient,
    gameId: string
  ): Promise<PreviewContext> {
    const game = await transaction.game.findUnique({
      where: { id: gameId },
      include: previewGameInclude
    });
    if (game === null) throw notFound('NOT_FOUND');
    if (game.status !== GameStatus.SETTLING) throw conflict('GAME_STATE_CONFLICT');
    const settings = await transaction.systemSetting.findUniqueOrThrow({
      where: { id: SETTINGS_ID }
    });
    return {
      game,
      players: game.players,
      buyinEvents: game.buyinEvents,
      settings
    };
  }

  private toDraftDto(
    actor: Pick<AuthUser, 'id' | 'role'>,
    draft: DraftWithEditor,
    context: PreviewContext
  ): SettlementDraftDto {
    const payload = parseStoredSettlementDraftPayload(draft.payload);
    return {
      gameId: draft.gameId,
      version: draft.version,
      editorUserId: draft.editorUserId,
      editorNickname: draft.editorUser.nickname,
      leaseExpiresAt: draft.leaseExpiresAt.toISOString(),
      canEdit: actor.id === draft.editorUserId &&
        (actor.role === 'ADMIN' || actor.role === 'SUPER_ADMIN' || actor.id === context.game.createdById),
      canTakeOver: actor.id !== draft.editorUserId &&
        (actor.role === 'ADMIN' || actor.role === 'SUPER_ADMIN') &&
        draft.leaseExpiresAt.getTime() <= Date.now(),
      payload,
      ...buildSettlementPreview(context, payload, draft.version)
    };
  }

  private async publishSafely(gameId: string): Promise<void> {
    await this.events.publishCommittedGame(gameId).catch(() => undefined);
  }
}
