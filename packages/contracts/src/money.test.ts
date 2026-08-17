import { describe, expect, it } from 'vitest';
import { formatMoney, moneyJsonSchema, parseMoney, type MoneyJson } from './money.js';

describe('money contract', () => {
  it('round-trips signed integer amounts without floating point', () => {
    expect(parseMoney('0')).toBe(0n);
    expect(parseMoney('-1200')).toBe(-1200n);
    expect(formatMoney(98765432101234567890n)).toBe('98765432101234567890');
  });

  it('accepts canonical base-10 integer strings only', () => {
    expect(moneyJsonSchema.safeParse('12').success).toBe(true);
    expect(moneyJsonSchema.safeParse('-12').success).toBe(true);
    expect(moneyJsonSchema.safeParse('0').success).toBe(true);
    expect(moneyJsonSchema.safeParse('01').success).toBe(false);
    expect(moneyJsonSchema.safeParse('+1').success).toBe(false);
    expect(moneyJsonSchema.safeParse('1.2').success).toBe(false);
  });

  it('rejects non-canonical values when parsing at runtime', () => {
    expect(() => parseMoney('01' as MoneyJson)).toThrow();
    expect(() => parseMoney('+1' as MoneyJson)).toThrow();
  });
});
