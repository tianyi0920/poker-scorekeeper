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

  it('rejects a timestamp after the MySQL DATETIME(3) ceiling', () => {
    const maximum = new Date('9999-12-31T23:59:59.999Z');
    expect(nextLedgerCreatedAt(undefined, maximum)).toEqual(maximum);
    expect(() => nextLedgerCreatedAt(maximum, maximum))
      .toThrow('BUYIN_TIMESTAMP_OVERFLOW');
    expect(() => nextLedgerCreatedAt(undefined, new Date('+010000-01-01T00:00:00.000Z')))
      .toThrow('BUYIN_TIMESTAMP_OVERFLOW');
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

  it('rejects a repeated logical BUY and a repeated physical event id', () => {
    expect(() => foldBuyinEvents([buy(1), { ...buy(2), id: 'another-event' }]))
      .toThrow('BUYIN_LOGICAL_BUY_DUPLICATE');
    expect(() => foldBuyinEvents([buy(1), { ...buy(2, 'buy-2'), id: 'buy-1-event' }]))
      .toThrow('BUYIN_EVENT_DUPLICATE');
  });

  it.each([
    ['BUY previousHands must be null', { ...buy(2), previousHands: 0 }],
    ['BUY newHands must match delta', { ...buy(2), newHands: 3 }],
    ['BUY values must be safe integers', { ...buy(2), handsDelta: 1.5 }],
    ['unknown event type', { ...buy(2), type: 'REPLACE' }]
  ])('rejects malformed ledger event: %s', (_label, malformed) => {
    expect(() => foldBuyinEvents([malformed as LedgerEvent]))
      .toThrow('BUYIN_EVENT_INVALID');
  });

  it.each([
    ['previousHands disagrees with the chain', { ...adjust(-1, 'buy-1', 4), newHands: 3 }],
    ['newHands disagrees with delta', { ...adjust(-1, 'buy-1', 5), newHands: 3 }],
    ['ADJUST values must be safe integers', { ...adjust(-1, 'buy-1', 5), newHands: 4.5 }]
  ])('rejects malformed adjustment: %s', (_label, malformed) => {
    expect(() => foldBuyinEvents([buy(5), malformed]))
      .toThrow('BUYIN_EVENT_INVALID');
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
