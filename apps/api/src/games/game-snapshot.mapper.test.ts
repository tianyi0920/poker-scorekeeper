import { describe, expect, it } from 'vitest';
import { AvatarKind } from '../generated/prisma/client.js';
import { mapGameSnapshot } from './game-snapshot.mapper.js';

describe('mapGameSnapshot', () => {
  it('includes the game creator id in the actor-neutral snapshot', () => {
    const result = mapGameSnapshot({
      id: 'game-1',
      createdById: 'user-creator',
      name: '快照测试局',
      status: 'ACTIVE',
      version: 1,
      handPrice: 1n,
      rakeEnabled: true,
      startedAt: null,
      stoppedAt: null,
      players: [{
        id: 'player-1',
        userId: 'user-player',
        nicknameSnapshot: '玩家',
        avatarKindSnapshot: AvatarKind.PRESET,
        avatarValueSnapshot: 'preset-01',
        seatNo: 1
      }],
      buyinEvents: []
    });

    expect(result).toMatchObject({
      createdById: 'user-creator',
      players: [{ avatarUrl: '/avatars/preset-01.webp' }]
    });
  });
});
