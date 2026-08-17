import { describe, expect, it } from 'vitest';
import { gameSnapshotSchema } from './games.js';

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
