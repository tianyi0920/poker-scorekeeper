import { Inject, Injectable } from '@nestjs/common';
import {
  canonicalPublicIdSchema,
  type ManagedGamesResponseDto
} from '@poker/contracts';
import { z } from 'zod';
import { badRequest } from '../common/errors/app-error.js';
import { PrismaService } from '../prisma/prisma.service.js';

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
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

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
}
