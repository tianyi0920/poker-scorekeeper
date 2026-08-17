import { z } from 'zod';
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

export type CreateGameRequest = z.infer<typeof createGameSchema>;
export type GameSpectatorSnapshotDto = z.infer<typeof gameSpectatorSnapshotSchema>;
export type GameSnapshotDto = z.infer<typeof gameSnapshotSchema>;
export type CurrentGamesResponse = z.infer<typeof currentGamesResponseSchema>;
