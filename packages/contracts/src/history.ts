import { z } from 'zod';
import { canonicalPublicIdSchema } from './buyins.js';
import { settlementBreakdownSchema } from './settlement.js';

const offsetDateTimeSchema = z.iso.datetime({ offset: true });

export const settlementDetailSchema = settlementBreakdownSchema.extend({
  game: z.object({
    id: canonicalPublicIdSchema,
    name: z.string().min(1).max(128),
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
  final: z.string()
}).strict();

export const historyResponseSchema = z.object({
  items: z.array(historyListItemSchema),
  nextCursor: z.string().nullable()
}).strict();

export type SettlementDetailDto = z.infer<typeof settlementDetailSchema>;
export type HistoryListItemDto = z.infer<typeof historyListItemSchema>;
export type HistoryResponseDto = z.infer<typeof historyResponseSchema>;
