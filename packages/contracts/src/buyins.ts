import { z } from 'zod';

export const idempotencyKeySchema = z.string().min(1).max(128);

export const buyHandsSchema = z.object({
  hands: z.number().int().min(1).max(99),
  idempotencyKey: idempotencyKeySchema
}).strict();

export const adjustLatestBuyinSchema = z.object({
  newHands: z.number().int().min(0).max(99),
  idempotencyKey: idempotencyKeySchema
}).strict();

export const buyinEventResponseSchema = z.object({
  eventId: z.string(),
  gameId: z.string(),
  playerId: z.string(),
  actorUserId: z.string(),
  type: z.enum(['BUY', 'ADJUST']),
  logicalBuyId: z.string(),
  previousHands: z.number().int().nullable(),
  newHands: z.number().int().min(0).max(99),
  handsDelta: z.number().int(),
  replayed: z.boolean(),
  gameVersion: z.number().int().positive()
});

export type BuyHandsRequest = z.infer<typeof buyHandsSchema>;
export type AdjustLatestBuyinRequest = z.infer<typeof adjustLatestBuyinSchema>;
export type BuyinEventResponse = z.infer<typeof buyinEventResponseSchema>;
