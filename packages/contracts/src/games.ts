import { z } from 'zod';
import { canonicalPublicIdSchema } from './buyins.js';
import { moneyJsonSchema } from './money.js';
import { nonNegativeMoneyJsonSchema } from './settings.js';

export const gameStatusSchema = z.enum([
  'DRAFT',
  'ACTIVE',
  'SETTLING',
  'COMPLETED',
  'VOIDED'
]);

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
}

export const gameNameSchema = z.string()
  .trim()
  .min(1)
  .max(40)
  .refine((value) => ![...value].some(isControlCharacter));

export const positiveMoneyJsonSchema = nonNegativeMoneyJsonSchema
  .refine((value) => value !== '0', { message: 'Money value must be positive' });

export const nonNegativeComputedMoneyJsonSchema = moneyJsonSchema
  .refine((value) => !value.startsWith('-'), { message: 'Money value must be non-negative' });

const offsetDateTimeSchema = z.iso.datetime({ offset: true });

export const createGameSchema = z.object({
  name: gameNameSchema.optional(),
  handPrice: positiveMoneyJsonSchema.default('300'),
  rakeEnabled: z.boolean().default(true)
}).strict();

export const gamePlayerSnapshotSchema = z.object({
  id: z.string(),
  userId: z.string(),
  nickname: z.string(),
  avatarUrl: z.string(),
  seatNo: z.number().int().min(1).max(12),
  effectiveHands: z.number().int().nonnegative(),
  buyInAmount: nonNegativeComputedMoneyJsonSchema
});

export const gamePurchaseSnapshotSchema = z.object({
  id: z.string(),
  playerId: z.string(),
  actorNickname: z.string(),
  type: z.enum(['BUY', 'ADJUST']),
  previousHands: z.number().int().nullable(),
  newHands: z.number().int().nonnegative(),
  handsDelta: z.number().int(),
  createdAt: offsetDateTimeSchema
});

export const gameSpectatorSnapshotSchema = z.object({
  userId: z.string(),
  nickname: z.string(),
  avatarUrl: z.string()
});

export const gameSnapshotSchema = z.object({
  id: z.string(),
  createdById: z.string(),
  name: z.string(),
  status: gameStatusSchema,
  version: z.number().int().positive(),
  handPrice: positiveMoneyJsonSchema,
  rakeEnabled: z.boolean(),
  startedAt: offsetDateTimeSchema.nullable(),
  stoppedAt: offsetDateTimeSchema.nullable(),
  serverNow: offsetDateTimeSchema,
  players: z.array(gamePlayerSnapshotSchema),
  purchases: z.array(gamePurchaseSnapshotSchema),
  spectators: z.array(gameSpectatorSnapshotSchema)
});

export const currentGamesResponseSchema = z.object({
  games: z.array(gameSnapshotSchema)
});

export const managedGameSchema = z.object({
  id: canonicalPublicIdSchema,
  name: gameNameSchema,
  status: gameStatusSchema,
  createdAt: offsetDateTimeSchema,
  startedAt: offsetDateTimeSchema.nullable(),
  completedAt: offsetDateTimeSchema.nullable(),
  playerCount: z.number().int().min(0).max(12)
}).strict();

export const managedGamesResponseSchema = z.object({
  items: z.array(managedGameSchema),
  nextCursor: z.string().min(1).nullable()
}).strict();

export const hardDeleteGameResponseSchema = z.object({
  deletedGameId: canonicalPublicIdSchema
}).strict();

export type CreateGameRequest = z.infer<typeof createGameSchema>;
export type GameSpectatorSnapshotDto = z.infer<typeof gameSpectatorSnapshotSchema>;
export type GameSnapshotDto = z.infer<typeof gameSnapshotSchema>;
export type CurrentGamesResponse = z.infer<typeof currentGamesResponseSchema>;
export type ManagedGameDto = z.infer<typeof managedGameSchema>;
export type ManagedGamesResponseDto = z.infer<typeof managedGamesResponseSchema>;
export type HardDeleteGameResponseDto = z.infer<typeof hardDeleteGameResponseSchema>;
