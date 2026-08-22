import type { MoneyJson } from '@poker/contracts';

export type MoneyTone = 'positive' | 'negative' | 'neutral';

function formatAbsolute(value: bigint): string {
  return new Intl.NumberFormat('zh-CN').format(value < 0n ? -value : value);
}

export function formatSignedMoney(value: MoneyJson): string {
  const parsed = BigInt(value);
  const prefix = parsed > 0n ? '+' : parsed < 0n ? '−' : '';
  return `${prefix}¥${formatAbsolute(parsed)}`;
}

export function formatUnsignedMoney(value: MoneyJson): string {
  return `¥${formatAbsolute(BigInt(value))}`;
}

export function finalMoneyPresentation(value: MoneyJson): { label: '最终应收' | '最终应付' | '最终收支'; amount: string; tone: MoneyTone } {
  const parsed = BigInt(value);
  return {
    label: parsed > 0n ? '最终应收' : parsed < 0n ? '最终应付' : '最终收支',
    amount: formatUnsignedMoney(value),
    tone: parsed > 0n ? 'positive' : parsed < 0n ? 'negative' : 'neutral'
  };
}
