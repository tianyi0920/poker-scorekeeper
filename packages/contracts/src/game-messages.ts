import { z } from 'zod';
import { canonicalPublicIdSchema } from './buyins.js';

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

export const gameMessageTextSchema = z.string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !hasControlCharacter(value));

export const createGameMessageRequestSchema = z.object({
  text: gameMessageTextSchema
}).strict();

export const gameMessageSchema = z.object({
  id: z.uuid(),
  gameId: canonicalPublicIdSchema,
  userId: canonicalPublicIdSchema,
  nickname: z.string().min(1),
  avatarUrl: z.string().min(1),
  text: gameMessageTextSchema,
  createdAt: z.iso.datetime({ offset: true })
}).strict();

export const gameMessagesResponseSchema = z.object({
  gameId: canonicalPublicIdSchema,
  messages: z.array(gameMessageSchema).max(50)
}).strict();

export type CreateGameMessageRequest = z.infer<typeof createGameMessageRequestSchema>;
export type GameMessageDto = z.infer<typeof gameMessageSchema>;
export type GameMessagesResponseDto = z.infer<typeof gameMessagesResponseSchema>;
