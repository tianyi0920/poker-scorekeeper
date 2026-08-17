import { describe, expect, it } from 'vitest';
import { allocateExpense } from './allocate-expense.js';

describe('allocateExpense', () => {
  it('splits 380 yuan among three players by profit then seat', () => {
    const result = allocateExpense(380n, ['a', 'b', 'c'], [
      { playerId: 'a', seatNo: 2, rawProfit: 900n },
      { playerId: 'b', seatNo: 1, rawProfit: 900n },
      { playerId: 'c', seatNo: 3, rawProfit: -1800n },
    ]);
    expect(result).toEqual(new Map([['b', 127n], ['a', 127n], ['c', 126n]]));
  });

  it('rejects negative fees and missing or unknown payers', () => {
    const players = [{ playerId: 'a', seatNo: 1, rawProfit: 1n }];
    expect(() => allocateExpense(-1n, ['a'], players)).toThrow('FEE_NEGATIVE');
    expect(() => allocateExpense(1n, [], players)).toThrow('FEE_PAYERS_REQUIRED');
    expect(() => allocateExpense(1n, ['missing'], players)).toThrow('UNKNOWN_FEE_PAYER');
  });

  it('rejects duplicate fee payers instead of silently deduplicating them', () => {
    expect(() => allocateExpense(10n, ['a', 'a'], [
      { playerId: 'a', seatNo: 1, rawProfit: 1n },
    ])).toThrow('DUPLICATE_FEE_PAYER');
  });

  it('returns zero shares for a zero fee without requiring payers', () => {
    expect(allocateExpense(0n, [], [])).toEqual(new Map());
  });
});
