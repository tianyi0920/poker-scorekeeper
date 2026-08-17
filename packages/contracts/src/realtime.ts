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
  }),
  z.object({
    ok: z.literal(false),
    code: realtimeErrorCodeSchema
  })
]);

export const gameLeaveAckSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), gameId: canonicalPublicIdSchema }),
  z.object({ ok: z.literal(false), code: realtimeErrorCodeSchema })
]);

export const presenceUpdatedEventSchema = z.object({
  gameId: canonicalPublicIdSchema,
  spectators: z.array(gameSpectatorSnapshotSchema)
});

export const rakeSettingsUpdatedEventSchema = z.object({
  version: z.number().int().positive()
});

export const playerRakeUpdatedEventSchema = z.object({
  userId: z.string()
});

export const serverErrorEventSchema = z.object({ code: realtimeErrorCodeSchema });

export const gameSnapshotEventSchema = gameSnapshotSchema;
export const gameUpdatedEventSchema = gameSnapshotSchema;

export type GameJoinCommand = z.infer<typeof gameJoinCommandSchema>;
export type GameLeaveCommand = z.infer<typeof gameLeaveCommandSchema>;
export type GameJoinAck = z.infer<typeof gameJoinAckSchema>;
export type GameLeaveAck = z.infer<typeof gameLeaveAckSchema>;
export type PresenceUpdatedEvent = z.infer<typeof presenceUpdatedEventSchema>;
export type RakeSettingsUpdatedEvent = z.infer<typeof rakeSettingsUpdatedEventSchema>;
export type PlayerRakeUpdatedEvent = z.infer<typeof playerRakeUpdatedEventSchema>;
export type ServerErrorEvent = z.infer<typeof serverErrorEventSchema>;
