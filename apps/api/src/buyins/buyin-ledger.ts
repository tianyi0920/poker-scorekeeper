export type LedgerEventType = 'BUY' | 'ADJUST';

export interface LedgerEvent {
  id: string;
  type: LedgerEventType;
  logicalBuyId: string;
  previousHands: number | null;
  newHands: number;
  handsDelta: number;
}

export interface EffectiveBuy {
  logicalBuyId: string;
  effectiveHands: number;
}

export class BuyinLedgerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'BuyinLedgerError';
  }
}

export function nextLedgerCreatedAt(last: Date | undefined, now: Date): Date {
  if (last === undefined || last.getTime() < now.getTime()) return now;
  return new Date(last.getTime() + 1);
}

export function foldBuyinEvents(events: readonly LedgerEvent[]): EffectiveBuy[] {
  const effectiveByLogicalBuy = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'BUY') {
      if (effectiveByLogicalBuy.has(event.logicalBuyId)) {
        throw new BuyinLedgerError('BUYIN_LOGICAL_BUY_DUPLICATE');
      }
      if (event.handsDelta < 0) throw new BuyinLedgerError('BUYIN_TOTAL_NEGATIVE');
      effectiveByLogicalBuy.set(event.logicalBuyId, event.handsDelta);
      continue;
    }

    const previous = effectiveByLogicalBuy.get(event.logicalBuyId);
    if (previous === undefined) {
      throw new BuyinLedgerError('BUYIN_LOGICAL_BUY_NOT_FOUND');
    }
    const next = previous + event.handsDelta;
    if (next < 0) throw new BuyinLedgerError('BUYIN_TOTAL_NEGATIVE');
    effectiveByLogicalBuy.set(event.logicalBuyId, next);
  }

  return [...effectiveByLogicalBuy].map(([logicalBuyId, effectiveHands]) => ({
    logicalBuyId,
    effectiveHands
  }));
}

export function assertLatestLogicalBuy(
  events: readonly LedgerEvent[],
  logicalBuyId: string
): void {
  const latestBuy = [...events].reverse().find((event) => event.type === 'BUY');
  if (latestBuy === undefined) throw new BuyinLedgerError('BUYIN_LOGICAL_BUY_NOT_FOUND');
  if (latestBuy.logicalBuyId !== logicalBuyId) {
    throw new BuyinLedgerError('BUYIN_NOT_LATEST');
  }
}
