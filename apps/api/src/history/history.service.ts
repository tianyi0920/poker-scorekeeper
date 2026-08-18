import { Inject, Injectable } from '@nestjs/common';
import {
  canonicalPublicIdSchema,
  formatMoney,
  type HistoryResponseDto,
  type SettlementDetailDto
} from '@poker/contracts';
import type { AuthUser } from '../common/auth/auth-user.js';
import { badRequest, notFound } from '../common/errors/app-error.js';
import { GameStatus, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { historyScope } from './history-policy.js';

interface Cursor { completedAt: string; id: string }

function decodeCursor(value: string | undefined): Cursor | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    if (typeof parsed.completedAt !== 'string' || typeof parsed.id !== 'string' || Number.isNaN(Date.parse(parsed.completedAt))) throw new Error();
    return parsed;
  } catch { throw badRequest('VALIDATION_ERROR'); }
}

function encodeCursor(value: Cursor): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }

const detailInclude = {
  settlement: { include: { results: { include: { gamePlayer: true }, orderBy: { gamePlayer: { seatNo: 'asc' } } } } }
} satisfies Prisma.GameInclude;

function detail(game: Prisma.GameGetPayload<{ include: typeof detailInclude }>): SettlementDetailDto {
  const settlement = game.settlement!;
  const startedAt = game.startedAt!;
  const stoppedAt = game.stoppedAt!;
  return {
    totals: { buyIn: formatMoney(settlement.buyInTotal), cashOut: formatMoney(settlement.cashOutTotal), roomFee: formatMoney(settlement.roomFee), otherFee: formatMoney(settlement.otherFee), rake: formatMoney(settlement.rakeTotal), final: formatMoney(settlement.finalTotal) },
    players: settlement.results.map((result) => ({
      playerId: result.gamePlayerId, nickname: result.gamePlayer.nicknameSnapshot,
      avatarKind: result.gamePlayer.avatarKindSnapshot, avatarValue: result.gamePlayer.avatarValueSnapshot, seatNo: result.gamePlayer.seatNo,
      buyIn: formatMoney(result.buyIn), cashOut: formatMoney(result.cashOut), rawProfit: formatMoney(result.rawProfit), roomFeeShare: formatMoney(result.roomFeeShare), otherFeeShare: formatMoney(result.otherFeeShare), afterFeeProfit: formatMoney(result.afterFeeProfit), rakeEligible: result.rakeEligible, rakeAmount: formatMoney(result.rakeAmount), finalAmount: formatMoney(result.finalAmount)
    })),
    game: { id: game.id, name: game.name, startedAt: startedAt.toISOString(), stoppedAt: stoppedAt.toISOString(), durationSeconds: Math.max(0, Math.floor((stoppedAt.getTime() - startedAt.getTime()) / 1000)) },
    completedAt: game.completedAt!.toISOString(), settledByNickname: settlement.settledByNicknameSnapshot, otherFeeNote: settlement.otherFeeNote, immutable: true
  };
}

@Injectable()
export class HistoryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(actor: AuthUser, rawLimit?: string, rawCursor?: string): Promise<HistoryResponseDto> {
    const parsedLimit = rawLimit === undefined ? 10 : Number(rawLimit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) throw badRequest('VALIDATION_ERROR');
    const limit = Math.min(parsedLimit, 50);
    const cursor = decodeCursor(rawCursor);
    const scope = historyScope(actor);
    const games = await this.prisma.game.findMany({
      where: { status: GameStatus.COMPLETED, completedAt: { not: null }, settlement: { isNot: null }, ...scope,
        ...(cursor === undefined ? {} : { OR: [{ completedAt: { lt: new Date(cursor.completedAt) } }, { completedAt: new Date(cursor.completedAt), id: { lt: cursor.id } }] }) },
      include: { settlement: { select: { finalTotal: true, settledByNicknameSnapshot: true } } },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }], take: limit + 1
    });
    const page = games.slice(0, limit);
    const final = page.at(-1);
    return { items: page.map((game) => ({ gameId: game.id, name: game.name, completedAt: game.completedAt!.toISOString(), settledByNickname: game.settlement!.settledByNicknameSnapshot, final: formatMoney(game.settlement!.finalTotal) })), nextCursor: games.length > limit && final !== undefined ? encodeCursor({ completedAt: final.completedAt!.toISOString(), id: final.id }) : null };
  }

  async get(gameId: string, actor: AuthUser): Promise<SettlementDetailDto> {
    if (!canonicalPublicIdSchema.safeParse(gameId).success) throw badRequest('VALIDATION_ERROR');
    const game = await this.prisma.game.findFirst({ where: { id: gameId, status: GameStatus.COMPLETED, ...historyScope(actor) }, include: detailInclude });
    if (game === null || game.settlement === null || game.completedAt === null || game.startedAt === null || game.stoppedAt === null) throw notFound('HISTORY_SCOPE_DENIED');
    return detail(game);
  }
}
