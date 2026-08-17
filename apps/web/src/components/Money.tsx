import type { MoneyJson } from '@poker/contracts';

export type MoneyTone = 'positive' | 'negative' | 'neutral';

export function Money({ value, tone }: { value: MoneyJson; tone?: MoneyTone }) {
  const amount = BigInt(value);
  const resolvedTone: MoneyTone = tone ?? (amount > 0n ? 'positive' : amount < 0n ? 'negative' : 'neutral');
  const formatted = new Intl.NumberFormat('zh-CN').format(amount);
  return <span className={`money money--${resolvedTone}`}>{formatted}</span>;
}
