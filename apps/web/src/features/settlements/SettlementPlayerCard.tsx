import type { MoneyJson, SettlementBreakdownDto } from '@poker/contracts';
import { finalMoneyPresentation, formatSignedMoney, formatUnsignedMoney, type MoneyTone } from '../../components/money-format.js';

export function signedMoney(value: MoneyJson): string {
  return formatSignedMoney(value);
}

function MoneyText({ label, value, tone, final = false }: { label: string; value: string; tone?: MoneyTone | 'expense' | 'rake'; final?: boolean }) {
  const className = ['settlement-metric', tone === 'expense' ? 'expense-metric' : '', tone === 'rake' ? 'rake-metric' : '', final ? 'settlement-metric--final' : ''].filter(Boolean).join(' ');
  const amountTone = tone === 'positive' || tone === 'negative' || tone === 'neutral' ? `money--${tone}` : '';
  return <div className={className}><dt>{label}</dt><dd className={amountTone}>{value}</dd></div>;
}

export function SettlementPlayerCard({ player, titlePrefix = '' }: { player: SettlementBreakdownDto['players'][number]; titlePrefix?: string }) {
  const rawTone = BigInt(player.rawProfit) > 0n ? 'money--positive' : BigInt(player.rawProfit) < 0n ? 'money--negative' : 'money--neutral';
  const final = finalMoneyPresentation(player.finalAmount);
  return <article className="settlement-player-card">
    <header><div><span className="seat-number">座位 {player.seatNo}</span><h3>{titlePrefix}{player.nickname}</h3></div><strong className={`raw-profit ${rawTone}`}>本局输赢 {formatSignedMoney(player.rawProfit)}</strong></header>
    <dl className="settlement-metrics settlement-metrics--simple">
      <MoneyText label="本局输赢" value={formatSignedMoney(player.rawProfit)} tone={BigInt(player.rawProfit) > 0n ? 'positive' : BigInt(player.rawProfit) < 0n ? 'negative' : 'neutral'} />
      <MoneyText label="房费" value={formatUnsignedMoney(player.roomFeeShare)} tone="expense" />
      {BigInt(player.otherFeeShare) !== 0n && <MoneyText label="其他费用" value={formatUnsignedMoney(player.otherFeeShare)} tone="expense" />}
      <MoneyText label="抽成" value={formatUnsignedMoney(player.rakeAmount)} tone="rake" />
      <MoneyText label={final.label} value={final.amount} tone={final.tone} final />
    </dl>
  </article>;
}
