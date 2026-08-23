import { z } from 'zod';
import { canonicalPublicIdSchema } from './buyins.js';
import { gameSnapshotSchema, gameSpectatorSnapshotSchema } from './games.js';

export const gameJoinCommandSchema = z.object({
  gameId: canonicalPublicIdSchema,
  knownVersion: z.number().int().nonnegative()
}).strict();

export const gameLeaveCommandSchema = z.object({
  gameId: canonicalPublicIdSchema
}).strict();

export const realtimeErrorCodeSchema = z.enum([
  'UNAUTHENTICATED',
  'PASSWORD_CHANGE_REQUIRED',
  'FORBIDDEN',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'INTERNAL_ERROR'
]);

export const gameJoinAckSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    gameId: canonicalPublicIdSchema,
    version: z.number().int().positive(),
    snapshotSent: z.boolean()
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: realtimeErrorCodeSchema
  }).strict()
]);

export const gameLeaveAckSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), gameId: canonicalPublicIdSchema }).strict(),
  z.object({ ok: z.literal(false), code: realtimeErrorCodeSchema }).strict()
]);

export const presenceUpdatedEventSchema = z.object({
  gameId: canonicalPublicIdSchema,
  spectators: z.array(gameSpectatorSnapshotSchema)
}).strict();

export const rakeSettingsUpdatedEventSchema = z.object({
  version: z.number().int().positive()
}).strict();

export const playerRakeUpdatedEventSchema = z.object({
  userId: canonicalPublicIdSchema
}).strict();

export const gameDeletedEventSchema = z.object({
  gameId: canonicalPublicIdSchema,
  reason: z.literal('HARD_DELETED')
}).strict();

export const serverErrorEventSchema = z.object({ code: realtimeErrorCodeSchema }).strict();

export const gameSnapshotEventSchema = gameSnapshotSchema.strict();
export const gameUpdatedEventSchema = gameSnapshotSchema.strict();

export type GameJoinCommand = z.infer<typeof gameJoinCommandSchema>;
export type GameLeaveCommand = z.infer<typeof gameLeaveCommandSchema>;
export type GameJoinAck = z.infer<typeof gameJoinAckSchema>;
export type GameLeaveAck = z.infer<typeof gameLeaveAckSchema>;
export type PresenceUpdatedEvent = z.infer<typeof presenceUpdatedEventSchema>;
export type RakeSettingsUpdatedEvent = z.infer<typeof rakeSettingsUpdatedEventSchema>;
export type PlayerRakeUpdatedEvent = z.infer<typeof playerRakeUpdatedEventSchema>;
export type GameDeletedEvent = z.infer<typeof gameDeletedEventSchema>;
export type ServerErrorEvent = z.infer<typeof serverErrorEventSchema>;
