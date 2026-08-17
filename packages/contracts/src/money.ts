import { z } from 'zod';

export const moneyJsonSchema = z.string().regex(/^(0|[1-9]\d*|-[1-9]\d*)$/);
export type MoneyJson = z.infer<typeof moneyJsonSchema>;

export function parseMoney(value: MoneyJson): bigint {
  return BigInt(moneyJsonSchema.parse(value));
}

export function formatMoney(value: bigint): MoneyJson {
  return value.toString() as MoneyJson;
}
