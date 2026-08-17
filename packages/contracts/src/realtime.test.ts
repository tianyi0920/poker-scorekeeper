import { describe, expect, it } from 'vitest';
import {
  gameJoinAckSchema,
  gameJoinCommandSchema,
  gameLeaveCommandSchema
} from './realtime.js';

describe('realtime contracts', () => {
  it('accepts a canonical game id and zero as the initial known version', () => {
    expect(gameJoinCommandSchema.parse({ gameId: 'cm123abc', knownVersion: 0 }))
      .toEqual({ gameId: 'cm123abc', knownVersion: 0 });
  });

  it.each([
    { gameId: 'CM123ABC', knownVersion: 0 },
    { gameId: 'cm123abc ', knownVersion: 0 },
    { gameId: 'cm123abc', knownVersion: -1 },
    { gameId: 'cm123abc', knownVersion: 0, extra: true }
  ])('rejects a non-canonical join payload: %j', (payload) => {
    expect(gameJoinCommandSchema.safeParse(payload).success).toBe(false);
  });

  it('keeps leave payloads strict and acknowledgements explicit', () => {
    expect(gameLeaveCommandSchema.safeParse({ gameId: 'cm123abc', extra: true }).success)
      .toBe(false);
    expect(gameJoinAckSchema.parse({
      ok: true,
      gameId: 'cm123abc',
      version: 1,
      snapshotSent: false
    })).toMatchObject({ ok: true, snapshotSent: false });
  });
});
