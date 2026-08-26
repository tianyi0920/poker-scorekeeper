import { Inject, Injectable } from '@nestjs/common';
import { formatMoney, type AllPlayerAggregationDto } from '@poker/contracts';
import type { AuthUser } from '../common/auth/auth-user.js';
import { badRequest, forbidden } from '../common/errors/app-error.js';
import { AvatarKind, GameStatus, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { HistoryAggregationRequest, HistoryFilter } from './history-filter.schema.js';
import { historyScope } from './history-policy.js';

const MIN_SIGNED_BIGINT = -9_223_372_036_854_775_808n;
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1_000;

const aggregationInclude = {
  settlement: {
    include: {
      results: {
        include: {
          gamePlayer: {
            include: {
              user: { select: { avatarKind: true, avatarValue: true } }
            }
          }
        }
      }
    }
  }
} satisfies Prisma.GameInclude;

type AggregationGame = Prisma.GameGetPayload<{ include: typeof aggregationInclude }>;

interface MutablePlayerAggregation {
  userId: string;
  nickname: string;
  avatarUrl: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  rawProfit: bigint;
  roomFeeShare: bigint;
  otherFeeShare: bigint;
  afterFeeProfit: bigint;
  rakeAmount: bigint;
  finalAmount: bigint;
  games: Array<{ gameId: string; gameName: string; completedAt: string; finalAmount: bigint }>;
}

function addMoney(left: bigint, right: bigint): bigint {
  const sum = left + right;
  if (sum < MIN_SIGNED_BIGINT || sum > MAX_SIGNED_BIGINT) throw badRequest('VALIDATION_ERROR');
  return sum;
}

function normalizedNickname(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function currentAvatarUrl(kind: AvatarKind, value: string): string {
  return kind === AvatarKind.PRESET
    ? `/avatars/${value}.webp`
    : `/avatars/uploads/${value}`;
}

function initialPlayer(userId: string, nickname: string, avatarUrl: string): MutablePlayerAggregation {
  return {
    userId,
    nickname,
    avatarUrl,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    rawProfit: 0n,
    roomFeeShare: 0n,
    otherFeeShare: 0n,
    afterFeeProfit: 0n,
    rakeAmount: 0n,
    finalAmount: 0n,
    games: []
  };
}

@Injectable()
export class AggregationService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async aggregate(actor: AuthUser, request: HistoryAggregationRequest): Promise<AllPlayerAggregationDto> {
    const games = 'gameIds' in request
      ? await this.resolveExplicitSelection(actor, request.gameIds)
      : await this.resolveQuickFilter(actor, request.filter);
    const players = new Map<string, MutablePlayerAggregation>();

    for (const game of games) {
      const settlement = game.settlement;
      if (settlement === null || game.completedAt === null) throw forbidden('HISTORY_SCOPE_DENIED');
      for (const result of settlement.results) {
        const snapshot = result.gamePlayer;
        const player = players.get(snapshot.userId) ?? initialPlayer(
          snapshot.userId,
          snapshot.nicknameSnapshot,
          currentAvatarUrl(snapshot.user.avatarKind, snapshot.user.avatarValue)
        );
        players.set(snapshot.userId, player);
        player.gamesPlayed += 1;
        if (result.rawProfit > 0n) player.wins += 1;
        if (result.rawProfit < 0n) player.losses += 1;
        player.rawProfit = addMoney(player.rawProfit, result.rawProfit);
        player.roomFeeShare = addMoney(player.roomFeeShare, result.roomFeeShare);
        player.otherFeeShare = addMoney(player.otherFeeShare, result.otherFeeShare);
        player.afterFeeProfit = addMoney(player.afterFeeProfit, result.afterFeeProfit);
        player.rakeAmount = addMoney(player.rakeAmount, result.rakeAmount);
        player.finalAmount = addMoney(player.finalAmount, result.finalAmount);
        player.games.push({
          gameId: game.id,
          gameName: game.name,
          completedAt: game.completedAt.toISOString(),
          finalAmount: result.finalAmount
        });
      }
    }

    const rows = [...players.values()]
      .sort((left, right) => {
        if (left.finalAmount !== right.finalAmount) return left.finalAmount > right.finalAmount ? -1 : 1;
        const nicknameOrder = normalizedNickname(left.nickname).localeCompare(normalizedNickname(right.nickname), 'zh-CN');
        return nicknameOrder !== 0 ? nicknameOrder : left.userId.localeCompare(right.userId);
      })
      .map((player) => ({
        userId: player.userId,
        nickname: player.nickname,
        avatarUrl: player.avatarUrl,
        gamesPlayed: player.gamesPlayed,
        wins: player.wins,
        losses: player.losses,
        rawProfit: formatMoney(player.rawProfit),
        roomFeeShare: formatMoney(player.roomFeeShare),
        otherFeeShare: formatMoney(player.otherFeeShare),
        afterFeeProfit: formatMoney(player.afterFeeProfit),
        rakeAmount: formatMoney(player.rakeAmount),
        finalAmount: formatMoney(player.finalAmount),
        games: player.games.map((game) => ({ ...game, finalAmount: formatMoney(game.finalAmount) }))
      }));

    return {
      gameIds: games.map(({ id }) => id),
      gameCount: games.length,
      playerCount: rows.length,
      players: rows
    };
  }

  private async resolveExplicitSelection(actor: AuthUser, gameIds: string[]): Promise<AggregationGame[]> {
    if (gameIds.length === 0) return [];
    const games = await this.prisma.game.findMany({
      where: {
        id: { in: gameIds },
        status: GameStatus.COMPLETED,
        completedAt: { not: null },
        settlement: { isNot: null },
        ...historyScope(actor)
      },
      include: aggregationInclude,
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }]
    });
    if (games.length !== gameIds.length) throw forbidden('HISTORY_SCOPE_DENIED');
    return games;
  }

  private async resolveQuickFilter(actor: AuthUser, filter: HistoryFilter): Promise<AggregationGame[]> {
    const now = new Date();
    const completedAt = this.completedAtForFilter(filter, now);
    const scope = filter.kind === 'MY_MONTH'
      ? { players: { some: { userId: actor.id } } }
      : historyScope(actor);
    return this.prisma.game.findMany({
      where: {
        status: GameStatus.COMPLETED,
        completedAt,
        settlement: { isNot: null },
        ...scope
      },
      include: aggregationInclude,
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      ...(filter.kind === 'RECENT_10' ? { take: 10 } : filter.kind === 'RECENT_30' ? { take: 30 } : {})
    });
  }

  private completedAtForFilter(filter: HistoryFilter, now: Date): Prisma.DateTimeNullableFilter {
    switch (filter.kind) {
      case 'RECENT_10':
      case 'RECENT_30':
        return { not: null };
      case 'LAST_30_DAYS':
        return { gte: new Date(now.getTime() - 30 * 86_400_000) };
      case 'LAST_90_DAYS':
        return { gte: new Date(now.getTime() - 90 * 86_400_000) };
      case 'MY_MONTH': {
        const start = new Date(Date.UTC(filter.year, filter.month - 1, 1) - SHANGHAI_UTC_OFFSET_MS);
        const end = new Date(Date.UTC(filter.year, filter.month, 1) - SHANGHAI_UTC_OFFSET_MS);
        return { gte: start, lt: end };
      }
      case 'CUSTOM_DATE_RANGE':
        return { gte: new Date(filter.startAt), lte: new Date(filter.endAt) };
    }
  }
}
