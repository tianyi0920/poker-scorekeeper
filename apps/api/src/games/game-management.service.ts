import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  canonicalPublicIdSchema,
  type HardDeleteGameResponseDto,
  type ManagedGamesResponseDto
} from '@poker/contracts';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { badRequest, forbidden } from '../common/errors/app-error.js';
import { Role } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GameEventsService } from '../realtime/game-events.service.js';
import { lockGameLifecycleCoordinator } from './game-lifecycle-coordinator.js';
import { lockGameForUpdate } from './game-lock.js';
import { GameMessagesService } from './game-messages.service.js';

export const managementQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(50),
  cursor: z.string().min(1).optional()
}).strict();

export type ManagementQuery = z.infer<typeof managementQuerySchema>;

const cursorSchema = z.object({
  createdAt: z.iso.datetime({ offset: true }),
  id: canonicalPublicIdSchema
}).strict();

interface ManagementCursor {
  createdAt: Date;
  id: string;
}

interface LockedOperatorRow {
  id: string;
  role: Role;
  isActive: boolean | bigint | number;
  deletedAt: Date | string | null;
}

function databaseBoolean(value: boolean | bigint | number): boolean {
  return value === true || value === 1 || value === 1n;
}

function decodeCursor(value: string | undefined): ManagementCursor | undefined {
  if (value === undefined) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url');
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new Error('Non-canonical base64url');
    const json = decoded.toString('utf8');
    if (!Buffer.from(json, 'utf8').equals(decoded)) throw new Error('Invalid UTF-8');
    const parsed = cursorSchema.parse(JSON.parse(json));
    return { createdAt: new Date(parsed.createdAt), id: parsed.id };
  } catch {
    throw badRequest('VALIDATION_ERROR');
  }
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id })).toString(
    'base64url'
  );
}

@Injectable()
export class GameManagementService {
  private readonly logger = new Logger(GameManagementService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(GameEventsService) private readonly events: GameEventsService,
    @Inject(GameMessagesService) private readonly gameMessages: GameMessagesService
  ) {}

  async list(query: ManagementQuery): Promise<ManagedGamesResponseDto> {
    const cursor = decodeCursor(query.cursor);
    const games = await this.prisma.game.findMany({
      where: cursor === undefined
        ? undefined
        : {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } }
            ]
          },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      include: { _count: { select: { players: true } } }
    });
    const page = games.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((game) => ({
        id: game.id,
        name: game.name,
        status: game.status,
        createdAt: game.createdAt.toISOString(),
        startedAt: game.startedAt?.toISOString() ?? null,
        completedAt: game.completedAt?.toISOString() ?? null,
        playerCount: game._count.players
      })),
      nextCursor: games.length > query.limit && last !== undefined
        ? encodeCursor(last.createdAt, last.id)
        : null
    };
  }

  async hardDelete(id: string, actor: AuthUser): Promise<HardDeleteGameResponseDto> {
    const response = await this.prisma.$transaction(async (transaction) => {
      await lockGameLifecycleCoordinator(transaction);
      const game = await lockGameForUpdate(transaction, id);
      const [operator] = await transaction.$queryRaw<LockedOperatorRow[]>`
        SELECT
          id,
          role,
          is_active AS isActive,
          deleted_at AS deletedAt
        FROM users
        WHERE id = ${actor.id}
        FOR UPDATE
      `;
      if (
        operator === undefined ||
        operator.role !== Role.SUPER_ADMIN ||
        !databaseBoolean(operator.isActive) ||
        operator.deletedAt !== null
      ) {
        throw forbidden('FORBIDDEN');
      }

      const deletedAt = new Date();
      const before = {
        id: game.id,
        name: game.name,
        status: game.status,
        deletedAt: deletedAt.toISOString()
      };
      const settlementIds = (await transaction.settlement.findMany({
        where: { gameId: id },
        select: { id: true }
      })).map(({ id: settlementId }) => settlementId);
      await transaction.settlementFeeAllocation.deleteMany({
        where: { settlementId: { in: settlementIds } }
      });
      await transaction.settlementResult.deleteMany({
        where: { settlementId: { in: settlementIds } }
      });
      await transaction.settlement.deleteMany({ where: { gameId: id } });
      await transaction.settlementDraft.deleteMany({ where: { gameId: id } });
      await transaction.buyinEvent.deleteMany({ where: { gameId: id } });
      await transaction.activePlayerLock.deleteMany({ where: { gameId: id } });
      await transaction.gamePlayer.deleteMany({ where: { gameId: id } });
      await transaction.game.delete({ where: { id } });
      await this.audit.record(transaction, {
        actorUserId: actor.id,
        action: 'GAME_HARD_DELETED',
        entityType: 'GAME',
        entityId: id,
        before
      });
      return { deletedGameId: id };
    });
    this.gameMessages.clear(id);
    try {
      await this.events.publishDeletedGame(id);
    } catch (error) {
      this.logger.error(
        `Failed to publish hard-deleted game ${id}`,
        error instanceof Error ? error.stack : undefined
      );
    }
    return response;
  }
}
