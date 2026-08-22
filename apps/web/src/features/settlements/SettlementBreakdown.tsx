import type { SettlementBreakdownDto } from '@poker/contracts';
import { formatUnsignedMoney } from '../../components/money-format.js';
import { SettlementPlayerCard } from './SettlementPlayerCard.js';

export function SettlementBreakdown({ breakdown, mode }: { breakdown: SettlementBreakdownDto; mode: 'preview' | 'history' }) {
  return <section className="settlement-breakdown" aria-label={mode === 'history' ? '历史结算明细' : '结算预览'}>
    <div className="settlement-breakdown-total"><span>总买入 {formatUnsignedMoney(breakdown.totals.buyIn)}</span><span>总带走 {formatUnsignedMoney(breakdown.totals.cashOut)}</span><span>总房费 {formatUnsignedMoney(breakdown.totals.roomFee)}</span>{BigInt(breakdown.totals.otherFee) !== 0n && <span>总其他费 {formatUnsignedMoney(breakdown.totals.otherFee)}</span>}<span>总抽成 {formatUnsignedMoney(breakdown.totals.rake)}</span></div>
    <div className="card-list">{breakdown.players.map((player) => <SettlementPlayerCard key={player.playerId} player={player} />)}</div>
  </section>;
}
