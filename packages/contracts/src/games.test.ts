import { describe, expect, it } from 'vitest';
import {
  gameSnapshotSchema,
  hardDeleteGameResponseSchema,
  managedGameSchema,
  managedGamesResponseSchema
} from './games.js';

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'game-1',
    name: '8月17日晚场',
    status: 'ACTIVE',
    version: 1,
    handPrice: '300',
    rakeEnabled: true,
    startedAt: '2026-08-17T20:00:00+08:00',
    stoppedAt: null,
    serverNow: '2026-08-17T20:30:00Z',
    players: [],
    purchases: [],
    spectators: [],
    ...overrides
  };
}

describe('game snapshot contract', () => {
  it('requires timestamps with an explicit UTC offset', () => {
    expect(gameSnapshotSchema.safeParse(snapshot()).success).toBe(true);
    expect(gameSnapshotSchema.safeParse(snapshot({
      serverNow: '2026-08-17T20:30:00'
    })).success).toBe(false);
    expect(gameSnapshotSchema.safeParse(snapshot({
      purchases: [{
        id: 'event-1',
        playerId: 'player-1',
        actorNickname: '张三',
        type: 'BUY',
        previousHands: null,
        newHands: 1,
        handsDelta: 1,
        createdAt: '2026-08-17T20:15:00'
      }]
    })).success).toBe(false);
  });

  it('keeps exact computed buy-in values above the database BIGINT storage limit', () => {
    expect(gameSnapshotSchema.safeParse(snapshot({
      players: [{
        id: 'player-1',
        userId: 'user-1',
        nickname: '张三',
        avatarUrl: '/avatars/preset-01.webp',
        seatNo: 1,
        effectiveHands: 12,
        buyInAmount: '110680464442257309684'
      }]
    })).success).toBe(true);
  });
});

const managedGame = {
  id: 'cm123456789012345678901234',
  name: '测试局',
  status: 'VOIDED',
  createdAt: '2026-08-23T01:02:03.000+00:00',
  startedAt: null,
  completedAt: null,
  playerCount: 0
};

describe('game management contracts', () => {
  it('parses a paginated all-status management page', () => {
    expect(managedGamesResponseSchema.parse({
      items: [managedGame],
      nextCursor: 'eyJjcmVhdGVkQXQiOiIyMDI2LTA4LTIzVDAxOjAyOjAzLjAwMFoiLCJpZCI6ImNtMSJ9'
    }).items[0]?.status).toBe('VOIDED');

    expect(managedGamesResponseSchema.parse({ items: [], nextCursor: null }))
      .toEqual({ items: [], nextCursor: null });
  });

  it.each(['DRAFT', 'ACTIVE', 'SETTLING', 'COMPLETED', 'VOIDED'])(
    'accepts the %s game status',
    (status) => {
      expect(managedGameSchema.safeParse({ ...managedGame, status }).success).toBe(true);
    }
  );

  it('rejects an unknown game status', () => {
    expect(managedGameSchema.safeParse({ ...managedGame, status: 'DELETED' }).success)
      .toBe(false);
  });

  it('accepts the maximum player count and offset lifecycle timestamps', () => {
    expect(managedGameSchema.parse({
      ...managedGame,
      startedAt: '2026-08-23T09:02:03.000+08:00',
      completedAt: '2026-08-23T03:02:03.000+00:00',
      playerCount: 12
    })).toMatchObject({
      startedAt: '2026-08-23T09:02:03.000+08:00',
      completedAt: '2026-08-23T03:02:03.000+00:00',
      playerCount: 12
    });
  });

  it('accepts 40-code-point names and rejects 41-code-point names', () => {
    const fortyCodePointName = '牌'.repeat(40);
    const fortyOneCodePointName = `${fortyCodePointName}局`;

    expect(managedGameSchema.safeParse({ ...managedGame, name: fortyCodePointName }).success)
      .toBe(true);
    expect(managedGameSchema.safeParse({ ...managedGame, name: fortyOneCodePointName }).success)
      .toBe(false);
  });

  it.each([
    { ...managedGame, id: 'CM123' },
    { ...managedGame, name: ' ' },
    { ...managedGame, createdAt: '2026-08-23T01:02:03.000' },
    { ...managedGame, startedAt: '2026-08-23T01:02:03.000' },
    { ...managedGame, completedAt: '2026-08-23T01:02:03.000' },
    { ...managedGame, playerCount: -1 },
    { ...managedGame, playerCount: 1.5 },
    { ...managedGame, playerCount: 13 },
    { ...managedGame, extra: true }
  ])('rejects an invalid managed game: %j', (value) => {
    expect(managedGameSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    { items: [managedGame], nextCursor: '' },
    { items: [managedGame], nextCursor: null, extra: true }
  ])('rejects an invalid management page: %j', (value) => {
    expect(managedGamesResponseSchema.safeParse(value).success).toBe(false);
  });

  it('accepts only a strict canonical hard-delete response', () => {
    expect(hardDeleteGameResponseSchema.parse({
      deletedGameId: 'cm123456789012345678901234'
    })).toEqual({ deletedGameId: 'cm123456789012345678901234' });

    expect(hardDeleteGameResponseSchema.safeParse({ deletedGameId: 'CM123' }).success)
      .toBe(false);
    expect(hardDeleteGameResponseSchema.safeParse({
      deletedGameId: 'cm123456789012345678901234',
      extra: true
    }).success).toBe(false);
  });
});
