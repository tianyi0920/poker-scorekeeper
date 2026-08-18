import { z } from 'zod';
import { canonicalPublicIdSchema } from '@poker/contracts';

const offsetDateTimeSchema = z.iso.datetime({ offset: true });

export const MAX_HISTORY_AGGREGATION_GAMES = 100;

const explicitGameSelectionSchema = z.object({
  gameIds: z.array(canonicalPublicIdSchema).max(MAX_HISTORY_AGGREGATION_GAMES)
    .refine((gameIds) => new Set(gameIds).size === gameIds.length, { message: 'DUPLICATE_GAME_ID' })
}).strict();

export const historyFilterSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('RECENT_10') }).strict(),
  z.object({ kind: z.literal('RECENT_30') }).strict(),
  z.object({ kind: z.literal('LAST_30_DAYS') }).strict(),
  z.object({ kind: z.literal('LAST_90_DAYS') }).strict(),
  z.object({
    kind: z.literal('CUSTOM_DATE_RANGE'),
    startAt: offsetDateTimeSchema,
    endAt: offsetDateTimeSchema
  }).strict().refine(({ startAt, endAt }) => Date.parse(startAt) <= Date.parse(endAt), {
    message: 'INVALID_DATE_RANGE'
  })
]);

const quickFilterSelectionSchema = z.object({ filter: historyFilterSchema }).strict();

export const historyAggregationRequestSchema = z.union([
  explicitGameSelectionSchema,
  quickFilterSelectionSchema
]);

export type HistoryFilter = z.infer<typeof historyFilterSchema>;
export type HistoryAggregationRequest = z.infer<typeof historyAggregationRequestSchema>;
