import type { MoneyJson, SettlementBreakdownDto } from '@poker/contracts';
import { formatSignedPoints, formatUnsignedMoney, formatUnsignedPoints } from '../../components/money-format.js';
import { SettlementPlayerCard } from './SettlementPlayerCard.js';

type Player = SettlementBreakdownDto['players'][number];

function TransferSummaryCard({ id, title, subtitle, tone, rows }: { id: string; title: string; subtitle: string; tone: 'receivable' | 'payable' | 'expense'; rows: Array<{ player: Player; amount: string }> }) {
  return <section className={`settlement-transfer-card settlement-transfer-card--${tone}`} role="region" aria-labelledby={id}>
    <header><div><h3 id={id}>{title}</h3><p>{subtitle}</p></div></header>
    {rows.length === 0
      ? <p className="settlement-transfer-empty">暂无</p>
      : <ul>{rows.map(({ player, amount }) => <li key={player.playerId}><span>{player.nickname}</span><strong className={tone === 'receivable' ? 'money--negative' : tone === 'payable' ? 'money--positive' : 'rake-value'}>{amount}</strong></li>)}</ul>}
  </section>;
}

function SettlementTransferSummary({ players }: { players: Player[] }) {
  const receivables = players.filter((player) => BigInt(player.finalAmount) < 0n).map((player) => ({ player, amount: formatSignedPoints(player.finalAmount) }));
  const payables = players.filter((player) => BigInt(player.afterFeeProfit) > 0n).map((player) => ({ player, amount: formatSignedPoints(player.afterFeeProfit) }));
  const expenses = players.filter((player) => BigInt(player.rakeAmount) > 0n).map((player) => ({ player, amount: formatUnsignedPoints(player.rakeAmount) }));
  return <section className="settlement-transfer-summary" aria-label="结算转账汇总">
    <TransferSummaryCard id="bank-receivables" title="银行应收积分" subtitle="需转给银行" tone="receivable" rows={receivables} />
    <TransferSummaryCard id="bank-payables" title="银行应付积分" subtitle="银行需付" tone="payable" rows={payables} />
    {expenses.length > 0 && <TransferSummaryCard id="settlement-expenses" title="经费积分" subtitle="单独转给固定人员" tone="expense" rows={expenses} />}
  </section>;
}

export function SettlementBreakdown({ breakdown, mode, handPrice }: { breakdown: SettlementBreakdownDto; mode: 'preview' | 'history'; handPrice?: MoneyJson }) {
  return <section className="settlement-breakdown" aria-label={mode === 'history' ? '历史结算明细' : '结算预览'}>
    <div className="settlement-breakdown-total"><span>总买入 {formatUnsignedMoney(breakdown.totals.buyIn)}</span><span>总带走 {formatUnsignedMoney(breakdown.totals.cashOut)}</span><span>总房费 {formatUnsignedMoney(breakdown.totals.roomFee)}</span>{BigInt(breakdown.totals.otherFee) !== 0n && <span>总其他费 {formatUnsignedMoney(breakdown.totals.otherFee)}</span>}<span>总抽成 {formatUnsignedMoney(breakdown.totals.rake)}</span></div>
    {mode === 'history' && <><SettlementTransferSummary players={breakdown.players} /><h2 className="settlement-personal-heading">个人明细</h2></>}
    <div className="card-list settlement-personal-list">{breakdown.players.map((player) => <SettlementPlayerCard key={player.playerId} player={player} mode={mode} handPrice={handPrice} />)}</div>
  </section>;
}
