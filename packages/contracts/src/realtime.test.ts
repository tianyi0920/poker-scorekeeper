import { describe, expect, it } from 'vitest';
import {
  gameDeletedEventSchema,
  gameJoinAckSchema,
  gameJoinCommandSchema,
  gameLeaveAckSchema,
  gameLeaveCommandSchema,
  gameMessageCreatedEventSchema,
  gameSnapshotEventSchema,
  gameUpdatedEventSchema,
  playerRakeUpdatedEventSchema,
  presenceUpdatedEventSchema,
  rakeSettingsUpdatedEventSchema,
  serverErrorEventSchema
} from './realtime.js';

describe('realtime contracts', () => {
  it('accepts only a strict current-game message event', () => {
    const message = {
      id: '018f5d0d-43a8-7a7a-9b0b-0e8d9de76e01',
      gameId: 'cm123abc',
      userId: 'cm456def',
      nickname: '西西',
      avatarUrl: '/avatars/preset-13.webp',
      text: '马上到',
      createdAt: '2026-08-24T09:00:00.000Z'
    };

    expect(gameMessageCreatedEventSchema.parse(message)).toEqual(message);
    expect(gameMessageCreatedEventSchema.safeParse({ ...message, extra: true }).success)
      .toBe(false);
  });

  it('accepts only the hard-delete realtime reason', () => {
    expect(gameDeletedEventSchema.parse({
      gameId: 'cm123456789012345678901234',
      reason: 'HARD_DELETED'
    })).toEqual({
      gameId: 'cm123456789012345678901234',
      reason: 'HARD_DELETED'
    });

    expect(gameDeletedEventSchema.safeParse({
      gameId: 'cm123456789012345678901234',
      reason: 'SOFT_DELETED'
    }).success).toBe(false);
    expect(gameDeletedEventSchema.safeParse({
      gameId: 'CM123',
      reason: 'HARD_DELETED'
    }).success).toBe(false);
    expect(gameDeletedEventSchema.safeParse({
      gameId: 'cm123456789012345678901234',
      reason: 'HARD_DELETED',
      extra: true
    }).success).toBe(false);
  });

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

  it.each([
    [gameJoinAckSchema, { ok: true, gameId: 'cm123abc', version: 1, snapshotSent: false, extra: true }],
    [gameJoinAckSchema, { ok: false, code: 'FORBIDDEN', extra: true }],
    [gameLeaveAckSchema, { ok: true, gameId: 'cm123abc', extra: true }],
    [gameLeaveAckSchema, { ok: false, code: 'INTERNAL_ERROR', extra: true }],
    [presenceUpdatedEventSchema, { gameId: 'cm123abc', spectators: [], extra: true }],
    [rakeSettingsUpdatedEventSchema, { version: 1, extra: true }],
    [playerRakeUpdatedEventSchema, { userId: 'cm123abc', extra: true }],
    [serverErrorEventSchema, { code: 'FORBIDDEN', extra: true }]
  ])('rejects unknown acknowledgement and event fields', (schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it.each(['CM123ABC', 'cm123abc ', 'not/canonical'])(
    'requires a canonical player-rake user id: %s',
    (userId) => {
      expect(playerRakeUpdatedEventSchema.safeParse({ userId }).success).toBe(false);
    }
  );

  it.each([gameSnapshotEventSchema, gameUpdatedEventSchema])(
    'keeps snapshot event envelopes strict',
    (schema) => {
      expect(schema.safeParse({
        id: 'cm123abc',
        name: 'Game',
        status: 'ACTIVE',
        version: 1,
        handPrice: '300',
        rakeEnabled: true,
        startedAt: '2026-08-18T00:00:00.000Z',
        stoppedAt: null,
        serverNow: '2026-08-18T00:00:01.000Z',
        players: [],
        purchases: [],
        spectators: [],
        extra: true
      }).success).toBe(false);
    }
  );
});
