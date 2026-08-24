import { z } from 'zod';
import { canonicalPublicIdSchema } from './buyins.js';
import { moneyJsonSchema } from './money.js';
import { settlementBreakdownSchema } from './settlement.js';

const offsetDateTimeSchema = z.iso.datetime({ offset: true });

export const settlementDetailSchema = settlementBreakdownSchema.extend({
  game: z.object({
    id: canonicalPublicIdSchema,
    name: z.string().min(1).max(128),
    handPrice: moneyJsonSchema.optional(),
    startedAt: offsetDateTimeSchema,
    stoppedAt: offsetDateTimeSchema,
    durationSeconds: z.number().int().nonnegative()
  }).strict(),
  completedAt: offsetDateTimeSchema,
  settledByNickname: z.string().min(1).max(64),
  otherFeeNote: z.string().max(500),
  immutable: z.literal(true)
});

export const historyListItemSchema = z.object({
  gameId: canonicalPublicIdSchema,
  name: z.string().min(1).max(128),
  completedAt: offsetDateTimeSchema,
  settledByNickname: z.string().min(1).max(64),
  myFinalAmount: moneyJsonSchema.nullable()
}).strict();

export const historyResponseSchema = z.object({
  items: z.array(historyListItemSchema).max(100),
  nextCursor: z.string().max(512).regex(/^[A-Za-z0-9_-]+$/).nullable()
}).strict().superRefine((value, context) => {
  const gameIds = new Set<string>();
  value.items.forEach((item, index) => {
    if (gameIds.has(item.gameId)) {
      context.addIssue({
        code: 'custom',
        path: ['items', index, 'gameId'],
        message: 'DUPLICATE_GAME_ID'
      });
    }
    gameIds.add(item.gameId);
  });
});

export const aggregatedHistoryGameSchema = z.object({
  gameId: canonicalPublicIdSchema,
  gameName: z.string().min(1).max(128),
  completedAt: offsetDateTimeSchema,
  finalAmount: moneyJsonSchema
}).strict();

export const allPlayerAggregationPlayerSchema = z.object({
  userId: canonicalPublicIdSchema,
  nickname: z.string().min(1).max(64),
  avatarUrl: z.string().min(1).max(512),
  gamesPlayed: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  rawProfit: moneyJsonSchema,
  roomFeeShare: moneyJsonSchema,
  otherFeeShare: moneyJsonSchema,
  afterFeeProfit: moneyJsonSchema,
  rakeAmount: moneyJsonSchema,
  finalAmount: moneyJsonSchema,
  games: z.array(aggregatedHistoryGameSchema)
}).strict().superRefine((value, context) => {
  const gameIds = new Set<string>();
  value.games.forEach((game, index) => {
    if (gameIds.has(game.gameId)) {
      context.addIssue({
        code: 'custom',
        path: ['games', index, 'gameId'],
        message: 'DUPLICATE_GAME_ID'
      });
    }
    gameIds.add(game.gameId);
  });
});

export const allPlayerAggregationSchema = z.object({
  gameIds: z.array(canonicalPublicIdSchema),
  gameCount: z.number().int().nonnegative(),
  playerCount: z.number().int().nonnegative(),
  players: z.array(allPlayerAggregationPlayerSchema)
}).strict().superRefine((value, context) => {
  const userIds = new Set<string>();
  value.players.forEach((player, index) => {
    if (userIds.has(player.userId)) {
      context.addIssue({
        code: 'custom',
        path: ['players', index, 'userId'],
        message: 'DUPLICATE_USER_ID'
      });
    }
    userIds.add(player.userId);
  });
});

export type SettlementDetailDto = z.infer<typeof settlementDetailSchema>;
export type HistoryListItemDto = z.infer<typeof historyListItemSchema>;
export type HistoryResponseDto = z.infer<typeof historyResponseSchema>;
export type AggregatedHistoryGameDto = z.infer<typeof aggregatedHistoryGameSchema>;
export type AllPlayerAggregationPlayerDto = z.infer<typeof allPlayerAggregationPlayerSchema>;
export type AllPlayerAggregationDto = z.infer<typeof allPlayerAggregationSchema>;
