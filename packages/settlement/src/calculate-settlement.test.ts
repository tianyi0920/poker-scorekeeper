import { describe, expect, it } from 'vitest';
import { calculateRake, calculateSettlement } from './calculate-settlement.js';

const balancedInput = () => ({
  gameRakeEnabled: false,
  rakeThreshold: 1000n,
  rakeBps: 1000,
  roomFee: 0n,
  roomPayerIds: [],
  otherFee: 0n,
  otherPayerIds: [],
  players: [
    { playerId: 'a', seatNo: 1, buyIn: 100n, cashOut: 100n, rakeEnabled: true },
  ],
});

describe('calculateRake', () => {
  it.each([
    ['threshold equal', 1000n, true, true, 1000, 100n],
    ['game rake disabled', 1200n, false, true, 1000, 0n],
    ['user rake disabled', 1200n, true, false, 1000, 0n],
    ['negative profit', -1200n, true, true, 1000, 0n],
    ['zero percent', 1200n, true, true, 0, 0n],
    ['one hundred percent', 1200n, true, true, 10000, 1200n],
  ])('%s', (_name, afterFee, gameEnabled, userEnabled, bps, expectedRake) => {
    expect(calculateRake(afterFee, { gameEnabled, userEnabled, threshold: 1000n, bps }))
      .toBe(expectedRake);
  });
});

describe('calculateSettlement', () => {
  it('accepts an all-zero balanced table', () => {
    expect(calculateSettlement({ ...balancedInput(), players: [] }).finalTotal).toBe(0n);
  });

  it('rejects unbalanced cash-outs', () => {
    const input = balancedInput();
    const player = input.players[0];
    if (!player) throw new Error('test fixture missing player');
    expect(() => calculateSettlement({
      ...input,
      players: [{ ...player, cashOut: 99n }],
    })).toThrow('TABLE_NOT_BALANCED');
  });

  it('calculates fees, threshold-equal rake, and final totals', () => {
    const result = calculateSettlement({
      gameRakeEnabled: true,
      rakeThreshold: 1000n,
      rakeBps: 1000,
      roomFee: 380n,
      roomPayerIds: ['a'],
      otherFee: 120n,
      otherPayerIds: ['a', 'b'],
      players: [
        { playerId: 'a', seatNo: 1, buyIn: 1500n, cashOut: 3000n, rakeEnabled: true },
        { playerId: 'b', seatNo: 2, buyIn: 900n, cashOut: 400n, rakeEnabled: true },
        { playerId: 'c', seatNo: 3, buyIn: 1200n, cashOut: 200n, rakeEnabled: true },
      ],
    });
    expect(result.results.find((row) => row.playerId === 'a')).toMatchObject({
      rawProfit: 1500n,
      roomFeeShare: 380n,
      otherFeeShare: 60n,
      afterFeeProfit: 1060n,
      rakeAmount: 106n,
      finalAmount: 954n,
    });
    expect(result.finalTotal).toBe(-606n);
  });
});
