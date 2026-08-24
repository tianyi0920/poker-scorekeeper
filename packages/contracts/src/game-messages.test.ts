import { describe, expect, it } from 'vitest';
import {
  createGameMessageRequestSchema,
  gameMessageSchema,
  gameMessagesResponseSchema
} from './game-messages.js';

const message = {
  id: '018f5d0d-43a8-7a7a-9b0b-0e8d9de76e01',
  gameId: 'cm123abc',
  userId: 'cm456def',
  nickname: '西西',
  avatarUrl: '/avatars/preset-13.webp',
  text: '马上到',
  createdAt: '2026-08-24T09:00:00.000Z'
};

describe('game message contracts', () => {
  it('trims and accepts one current-game message', () => {
    expect(createGameMessageRequestSchema.parse({ text: '  马上到  ' }))
      .toEqual({ text: '马上到' });
    expect(gameMessageSchema.parse(message)).toEqual(message);
    expect(gameMessagesResponseSchema.parse({ gameId: 'cm123abc', messages: [message] }).messages)
      .toHaveLength(1);
  });

  it.each([
    { text: '' },
    { text: ' '.repeat(4) },
    { text: 'a'.repeat(121) },
    { text: 'a\u0000b' }
  ])('rejects invalid text %#', (input) => {
    expect(createGameMessageRequestSchema.safeParse(input).success).toBe(false);
  });
});
