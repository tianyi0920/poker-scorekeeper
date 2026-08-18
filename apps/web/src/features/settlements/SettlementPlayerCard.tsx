import type { MoneyJson, SettlementBreakdownDto } from '@poker/contracts';
import { Money } from '../../components/Money.js';

export function signedMoney(value: MoneyJson): string {
  const amount = BigInt(value);
  const sign = amount > 0n ? '+' : amount < 0n ? '−' : '';
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}¥${new Intl.NumberFormat('zh-CN').format(absolute)}`;
}

export function settlementLabel(prefix: string, value: MoneyJson, stage: string): string {
  const amount = BigInt(value);
  if (amount === 0n) return `${prefix} · ${stage}结清`;
  return `${prefix} · ${stage}${amount > 0n ? '应收' : '应付'}`;
}

export function MoneyMetric({ label, value }: { label: string; value: MoneyJson }) {
  const amount = BigInt(value);
  return <div className="settlement-metric"><dt>{label}</dt><dd><span className="metric-sign">{amount > 0n ? '应收 ' : amount < 0n ? '应付 ' : '结清 '}</span><Money value={value} /> <span aria-hidden="true">({signedMoney(value)})</span></dd></div>;
}

export function SettlementPlayerCard({ player, titlePrefix = '' }: { player: SettlementBreakdownDto['players'][number]; titlePrefix?: string }) {
  const rawTone = BigInt(player.rawProfit) > 0n ? 'money--positive' : BigInt(player.rawProfit) < 0n ? 'money--negative' : 'money--neutral';
  return <article className="settlement-player-card">
    <header><div><span className="seat-number">座位 {player.seatNo}</span><h3>{titlePrefix}{player.nickname}</h3></div><strong className={`raw-profit ${rawTone}`}>牌局盈亏 {signedMoney(player.rawProfit)}</strong></header>
    <dl className="settlement-metrics">
      <MoneyMetric label="牌局盈亏" value={player.rawProfit} />
      <div className="settlement-metric expense-metric"><dt>费用扣减</dt><dd>房费 −¥{new Intl.NumberFormat('zh-CN').format(BigInt(player.roomFeeShare))} · 其他费 −¥{new Intl.NumberFormat('zh-CN').format(BigInt(player.otherFeeShare))}</dd></div>
      <MoneyMetric label={settlementLabel('费用后盈亏', player.afterFeeProfit, '抽成前')} value={player.afterFeeProfit} />
      <div className="settlement-metric rake-metric"><dt>抽成扣减</dt><dd>−¥{new Intl.NumberFormat('zh-CN').format(BigInt(player.rakeAmount))}</dd></div>
      <div className="settlement-metric--final"><MoneyMetric label={settlementLabel('最终金额', player.finalAmount, '最终')} value={player.finalAmount} /></div>
    </dl>
  </article>;
}
