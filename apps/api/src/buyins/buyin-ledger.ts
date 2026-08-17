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

const MYSQL_DATETIME_3_MAX = Date.parse('9999-12-31T23:59:59.999Z');

export function nextLedgerCreatedAt(last: Date | undefined, now: Date): Date {
  const nowMilliseconds = now.getTime();
  const lastMilliseconds = last?.getTime();
  if (
    !Number.isFinite(nowMilliseconds) ||
    (lastMilliseconds !== undefined && !Number.isFinite(lastMilliseconds))
  ) {
    throw new BuyinLedgerError('BUYIN_TIMESTAMP_INVALID');
  }
  const nextMilliseconds = lastMilliseconds === undefined || lastMilliseconds < nowMilliseconds
    ? nowMilliseconds
    : lastMilliseconds + 1;
  if (nextMilliseconds > MYSQL_DATETIME_3_MAX) {
    throw new BuyinLedgerError('BUYIN_TIMESTAMP_OVERFLOW');
  }
  return new Date(nextMilliseconds);
}

export function foldBuyinEvents(events: readonly LedgerEvent[]): EffectiveBuy[] {
  const effectiveByLogicalBuy = new Map<string, number>();
  const eventIds = new Set<string>();
  for (const event of events) {
    if (
      typeof event.id !== 'string' ||
      event.id.length === 0 ||
      typeof event.logicalBuyId !== 'string' ||
      event.logicalBuyId.length === 0
    ) {
      throw new BuyinLedgerError('BUYIN_EVENT_INVALID');
    }
    if (eventIds.has(event.id)) throw new BuyinLedgerError('BUYIN_EVENT_DUPLICATE');
    eventIds.add(event.id);

    if (event.type === 'BUY') {
      if (effectiveByLogicalBuy.has(event.logicalBuyId)) {
        throw new BuyinLedgerError('BUYIN_LOGICAL_BUY_DUPLICATE');
      }
      if (
        event.previousHands !== null ||
        !Number.isSafeInteger(event.newHands) ||
        !Number.isSafeInteger(event.handsDelta) ||
        event.newHands !== event.handsDelta
      ) {
        throw new BuyinLedgerError('BUYIN_EVENT_INVALID');
      }
      if (event.handsDelta < 0) throw new BuyinLedgerError('BUYIN_TOTAL_NEGATIVE');
      effectiveByLogicalBuy.set(event.logicalBuyId, event.handsDelta);
      continue;
    }

    if (event.type !== 'ADJUST') throw new BuyinLedgerError('BUYIN_EVENT_INVALID');

    const previous = effectiveByLogicalBuy.get(event.logicalBuyId);
    if (previous === undefined) {
      throw new BuyinLedgerError('BUYIN_LOGICAL_BUY_NOT_FOUND');
    }
    if (
      !Number.isSafeInteger(event.previousHands) ||
      !Number.isSafeInteger(event.newHands) ||
      !Number.isSafeInteger(event.handsDelta)
    ) {
      throw new BuyinLedgerError('BUYIN_EVENT_INVALID');
    }
    const next = previous + event.handsDelta;
    if (next < 0 || event.newHands < 0) {
      throw new BuyinLedgerError('BUYIN_TOTAL_NEGATIVE');
    }
    if (event.previousHands !== previous || event.newHands !== next) {
      throw new BuyinLedgerError('BUYIN_EVENT_INVALID');
    }
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
