import { describe, expect, it } from 'vitest';
import {
  assertLatestLogicalBuy,
  foldBuyinEvents,
  nextLedgerCreatedAt,
  type LedgerEvent
} from './buyin-ledger.js';

function buy(hands: number, logicalBuyId = 'buy-1'): LedgerEvent {
  return {
    id: `${logicalBuyId}-event`,
    type: 'BUY',
    logicalBuyId,
    previousHands: null,
    newHands: hands,
    handsDelta: hands
  };
}

function adjust(
  handsDelta: number,
  logicalBuyId = 'buy-1',
  previousHands?: number
): LedgerEvent {
  const previous = previousHands ?? 0;
  return {
    id: `${logicalBuyId}-adjust-${handsDelta}`,
    type: 'ADJUST',
    logicalBuyId,
    previousHands: previous,
    newHands: previous + handsDelta,
    handsDelta
  };
}

describe('buy-in event ledger', () => {
  it('keeps event ordering monotonic when the clock does not advance', () => {
    const last = new Date('2026-08-17T12:00:00.123Z');
    expect(nextLedgerCreatedAt(last, new Date('2026-08-17T12:00:00.123Z')))
      .toEqual(new Date('2026-08-17T12:00:00.124Z'));
    expect(nextLedgerCreatedAt(last, new Date('2026-08-17T12:00:01.000Z')))
      .toEqual(new Date('2026-08-17T12:00:01.000Z'));
  });

  it('keeps the original buy and appends a -2 correction', () => {
    expect(foldBuyinEvents([buy(5), adjust(-2, 'buy-1', 5)]))
      .toEqual([{ logicalBuyId: 'buy-1', effectiveHands: 3 }]);
  });

  it.each([
    ['repeat correction', [buy(5), adjust(-2, 'buy-1', 5), adjust(1, 'buy-1', 3)], 4],
    ['correct to zero', [buy(5), adjust(-5, 'buy-1', 5)], 0]
  ] as const)('%s', (_name, events, expectedHands) => {
    expect(foldBuyinEvents([...events])[0]?.effectiveHands).toBe(expectedHands);
  });

  it('rejects a negative effective total', () => {
    expect(() => foldBuyinEvents([buy(1), adjust(-2, 'buy-1', 1)]))
      .toThrow('BUYIN_TOTAL_NEGATIVE');
  });

  it('rejects a negative original purchase total', () => {
    expect(() => foldBuyinEvents([buy(-1)]))
      .toThrow('BUYIN_TOTAL_NEGATIVE');
  });

  it('rejects a correction that does not point at a prior logical buy', () => {
    expect(() => foldBuyinEvents([adjust(1, 'missing', 0)]))
      .toThrow('BUYIN_LOGICAL_BUY_NOT_FOUND');
  });

  it('keeps logical buys in their original deterministic order', () => {
    expect(foldBuyinEvents([
      buy(2, 'second-seat-purchase'),
      buy(1, 'later-purchase'),
      adjust(2, 'second-seat-purchase', 2)
    ])).toEqual([
      { logicalBuyId: 'second-seat-purchase', effectiveHands: 4 },
      { logicalBuyId: 'later-purchase', effectiveHands: 1 }
    ]);
  });

  it('refuses correction of an older logical buy', () => {
    expect(() => assertLatestLogicalBuy(
      [buy(2, 'first'), buy(1, 'second')],
      'first'
    )).toThrow('BUYIN_NOT_LATEST');
  });

  it('allows repeated corrections of the latest logical buy', () => {
    expect(() => assertLatestLogicalBuy(
      [buy(2, 'first'), buy(1, 'second'), adjust(1, 'second', 1)],
      'second'
    )).not.toThrow();
  });
});
