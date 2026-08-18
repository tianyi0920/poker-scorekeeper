import { describe, expect, it } from 'vitest';
import {
  saveSettlementDraftSchema,
  settlementDraftPayloadSchema,
  settlementDraftResponseSchema,
  settlementPreviewRequestSchema
} from './settlement.js';

const playerId = 'cm1234567890abcdef1234567890';

describe('settlement draft transport', () => {
  it('fills the approved fee defaults while preserving empty cash-outs', () => {
    expect(settlementDraftPayloadSchema.parse({
      cashOutByPlayerId: { [playerId]: '' }
    })).toEqual({
      cashOutByPlayerId: { [playerId]: '' },
      roomFee: '380',
      roomPayerIds: [],
      otherFee: '0',
      otherFeeNote: '',
      otherPayerIds: []
    });
  });

  it('rejects non-canonical money, public ids, duplicate payers, and unknown fields', () => {
    for (const payload of [
      { cashOutByPlayerId: { [playerId]: '-1' } },
      { cashOutByPlayerId: { [playerId]: '01' } },
      { cashOutByPlayerId: { [playerId.toUpperCase()]: '0' } },
      {
        cashOutByPlayerId: { [playerId]: '0' },
        roomPayerIds: [playerId, playerId]
      },
      { cashOutByPlayerId: { [playerId]: '0' }, surprise: true }
    ]) {
      expect(settlementDraftPayloadSchema.safeParse(payload).success).toBe(false);
    }
  });

  it('rejects money beyond signed BIGINT and requires an explanation for other fees', () => {
    expect(settlementDraftPayloadSchema.safeParse({
      cashOutByPlayerId: { [playerId]: '9223372036854775808' }
    }).success).toBe(false);
    expect(settlementDraftPayloadSchema.safeParse({
      cashOutByPlayerId: { [playerId]: '0' },
      otherFee: '1'
    }).success).toBe(false);
  });

  it('keeps save and preview commands strict and versioned', () => {
    const payload = { cashOutByPlayerId: { [playerId]: '0' } };
    expect(saveSettlementDraftSchema.safeParse({ version: 1, payload }).success).toBe(true);
    expect(saveSettlementDraftSchema.safeParse({ version: 0, payload }).success).toBe(false);
    expect(saveSettlementDraftSchema.safeParse({ version: 1, payload, extra: true }).success)
      .toBe(false);
    expect(settlementPreviewRequestSchema.safeParse(payload).success).toBe(true);
    expect(settlementPreviewRequestSchema.safeParse({ ...payload, extra: true }).success)
      .toBe(false);
  });

  it('validates the complete recoverable draft and preview response boundary', () => {
    const response = {
      gameId: playerId,
      version: 2,
      editorUserId: playerId,
      editorNickname: '天一',
      leaseExpiresAt: '2026-08-17T12:05:00.000Z',
      canEdit: true,
      canTakeOver: false,
      payload: {
        cashOutByPlayerId: { [playerId]: '300' },
        roomFee: '0',
        roomPayerIds: [],
        otherFee: '0',
        otherFeeNote: '',
        otherPayerIds: []
      },
      draftVersion: 2,
      settingsVersion: 1,
      previewReady: true,
      validationCode: null,
      confirmationToken: 'server-signed-confirmation',
      totals: {
        buyIn: '300', cashOut: '300', roomFee: '0', otherFee: '0', rake: '0', final: '0'
      },
      players: [{
        playerId,
        nickname: '天一',
        avatarKind: 'PRESET',
        avatarValue: 'preset-01',
        seatNo: 1,
        buyIn: '300',
        cashOut: '300',
        rawProfit: '0',
        roomFeeShare: '0',
        otherFeeShare: '0',
        afterFeeProfit: '0',
        rakeEligible: false,
        rakeAmount: '0',
        finalAmount: '0'
      }]
    };
    expect(settlementDraftResponseSchema.parse(response)).toEqual(response);
    expect(settlementDraftResponseSchema.safeParse({
      ...response,
      previewReady: false,
      validationCode: 'MONEY_OVERFLOW',
      confirmationToken: null
    }).success).toBe(true);
    expect(settlementDraftResponseSchema.safeParse({ ...response, extra: true }).success).toBe(false);
  });
});
