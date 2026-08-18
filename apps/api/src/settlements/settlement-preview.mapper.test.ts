import { describe, expect, it } from 'vitest';
import type { SettlementDraftPayload } from '@poker/contracts';
import { AvatarKind, BuyinEventType, GameStatus } from '../generated/prisma/client.js';
import {
  buildSettlementPreview,
  defaultFeePayersOnFirstBalance,
  type PreviewContext,
  type PreviewPlayer
} from './settlement-preview.mapper.js';

const gameId = 'cmgame1234567890';
const playerIds = ['cmplayer111111111', 'cmplayer222222222', 'cmplayer333333333'] as const;

function context(rakeEnabled = true): PreviewContext {
  const now = new Date('2026-08-17T12:00:00.000Z');
  const players: PreviewPlayer[] = playerIds.map((id, index) => ({
    id,
    gameId,
    userId: `cmuser${index}111111111`,
    nicknameSnapshot: `玩家${index + 1}`,
    avatarKindSnapshot: AvatarKind.PRESET,
    avatarValueSnapshot: 'preset-01',
    seatNo: index + 1,
    firstBuyinAt: now,
    createdAt: now,
    user: { rakeEnabled: index === 0 ? rakeEnabled : true }
  }));
  const hands = [5, 6, 1] as const;
  return {
    game: {
      id: gameId,
      name: '单元测试局',
      handPrice: 300n,
      rakeEnabled: true,
      status: GameStatus.SETTLING,
      version: 2,
      createdById: 'cmadmin111111111',
      startedAt: now,
      stoppedAt: now,
      completedAt: null,
      settledById: null,
      createdAt: now,
      updatedAt: now
    },
    players,
    buyinEvents: players.map((player, index) => ({
      id: `cmevent${index}111111111`,
      gameId,
      gamePlayerId: player.id,
      actorUserId: player.userId,
      type: BuyinEventType.BUY,
      logicalBuyId: `cmevent${index}111111111`,
      previousHands: null,
      newHands: hands[index]!,
      handsDelta: hands[index]!,
      gameVersion: index + 2,
      idempotencyKey: `mapper-${index}`,
      createdAt: new Date(now.getTime() + index)
    })),
    settings: {
      id: 'singleton',
      rakeThreshold: 1000n,
      rakeBps: 1000,
      version: 7,
      updatedById: null,
      createdAt: now,
      updatedAt: now
    }
  };
}

function payload(overrides: Partial<SettlementDraftPayload> = {}): SettlementDraftPayload {
  return {
    cashOutByPlayerId: {
      [playerIds[0]]: '3000',
      [playerIds[1]]: '400',
      [playerIds[2]]: '200'
    },
    roomFee: '380',
    roomPayerIds: [playerIds[0]],
    otherFee: '0',
    otherFeeNote: '',
    otherPayerIds: [],
    ...overrides
  };
}

describe('settlement preview mapping', () => {
  it('shows raw profit only for cash-outs already entered', () => {
    const result = buildSettlementPreview(context(), payload({
      cashOutByPlayerId: {
        [playerIds[0]]: '3000',
        [playerIds[1]]: '',
        [playerIds[2]]: ''
      }
    }), 2);

    expect(result).toMatchObject({
      previewReady: false,
      validationCode: 'CASH_OUTS_INCOMPLETE',
      confirmationToken: null,
      totals: { buyIn: '3600', cashOut: '3000' }
    });
    expect(result.players.map(({ rawProfit }) => rawProfit)).toEqual(['1500', '0', '0']);
  });

  it('maps the exact fee, rake, and final-money hierarchy', () => {
    const result = buildSettlementPreview(context(), payload(), 3);

    expect(result).toMatchObject({
      draftVersion: 3,
      settingsVersion: 7,
      previewReady: true,
      validationCode: null,
      totals: {
        buyIn: '3600',
        cashOut: '3600',
        roomFee: '380',
        otherFee: '0',
        rake: '112',
        final: '-492'
      }
    });
    expect(result.players[0]).toMatchObject({
      rawProfit: '1500',
      roomFeeShare: '380',
      otherFeeShare: '0',
      afterFeeProfit: '1120',
      rakeAmount: '112',
      finalAmount: '1008'
    });
  });

  it('reads the current user rake flag instead of a game snapshot', () => {
    const result = buildSettlementPreview(context(false), payload({ roomFee: '0', roomPayerIds: [] }), 4);
    expect(result.players[0]).toMatchObject({
      afterFeeProfit: '1500',
      rakeAmount: '0',
      finalAmount: '1500'
    });
  });

  it('defaults tied top winners by seat only on the first balanced transition', () => {
    const state = context();
    const empty = payload({
      cashOutByPlayerId: Object.fromEntries(playerIds.map((id) => [id, ''])),
      roomPayerIds: []
    });
    const tied = payload({
      cashOutByPlayerId: {
        [playerIds[0]]: '1600',
        [playerIds[1]]: '1900',
        [playerIds[2]]: '100'
      },
      roomPayerIds: []
    });
    const defaulted = defaultFeePayersOnFirstBalance(state, empty, tied);
    expect(defaulted.roomPayerIds).toEqual([playerIds[0]]);
    expect(defaultFeePayersOnFirstBalance(state, defaulted, {
      ...defaulted,
      roomPayerIds: []
    }).roomPayerIds).toEqual([]);
  });

  it('does not emit ready amounts outside signed BIGINT', () => {
    const result = buildSettlementPreview(context(), payload({
      roomFee: '9223372036854775807',
      roomPayerIds: [playerIds[0]],
      otherFee: '9223372036854775807',
      otherFeeNote: '极限费用',
      otherPayerIds: [playerIds[0]]
    }), 5);
    expect(result).toMatchObject({
      previewReady: false,
      validationCode: 'MONEY_OVERFLOW',
      confirmationToken: null
    });
  });

  it('does not sign an empty table even when fees and totals are zero', () => {
    const emptyContext = { ...context(), players: [], buyinEvents: [] };
    const result = buildSettlementPreview(emptyContext, payload({
      cashOutByPlayerId: {},
      roomFee: '0',
      roomPayerIds: [],
      otherFee: '0',
      otherPayerIds: []
    }), 6);

    expect(result).toMatchObject({
      previewReady: false,
      validationCode: 'CASH_OUTS_INCOMPLETE',
      confirmationToken: null,
      players: []
    });
  });
});
