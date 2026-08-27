import type { MoneyJson, SettlementBreakdownDto } from '@poker/contracts';
import { useState } from 'react';
import { finalMoneyPresentation, formatSignedMoney, formatSignedPoints, formatUnsignedMoney, type MoneyTone } from '../../components/money-format.js';
import { UserAvatar } from '../../components/UserAvatar.js';

export function signedMoney(value: MoneyJson): string {
  return formatSignedMoney(value);
}

function MoneyText({ label, value, tone, final = false }: { label: string; value: string; tone?: MoneyTone | 'expense' | 'rake'; final?: boolean }) {
  const className = ['settlement-metric', tone === 'expense' ? 'expense-metric' : '', tone === 'rake' ? 'rake-metric' : '', final ? 'settlement-metric--final' : ''].filter(Boolean).join(' ');
  const amountTone = tone === 'positive' || tone === 'negative' || tone === 'neutral' ? `money--${tone}` : '';
  return <div className={className}><dt>{label}</dt><dd className={amountTone}>{value}</dd></div>;
}

type Player = SettlementBreakdownDto['players'][number];

function moneyTone(value: MoneyJson): MoneyTone {
  const amount = BigInt(value);
  return amount > 0n ? 'positive' : amount < 0n ? 'negative' : 'neutral';
}

function signedDeduction(value: bigint): string {
  return value === 0n ? '¥0' : formatSignedMoney((-value).toString());
}

function purchasedHands(buyIn: MoneyJson, handPrice: MoneyJson | undefined): string {
  if (handPrice === undefined) return '—';
  const price = BigInt(handPrice);
  const total = BigInt(buyIn);
  if (price <= 0n || total < 0n || total % price !== 0n) return '—';
  return `${new Intl.NumberFormat('zh-CN').format(total / price)} 手`;
}

function DetailCell({ label, value, tone }: { label: string; value: string; tone?: MoneyTone | 'expense' | 'rake' }) {
  const className = tone === 'positive' || tone === 'negative' || tone === 'neutral' ? `money--${tone}` : tone === 'expense' ? 'expense-value' : tone === 'rake' ? 'rake-value' : '';
  return <div className="history-detail-cell"><dt>{label}</dt><dd className={className}>{value}</dd></div>;
}

function PreviewPlayerCard({ player, titlePrefix }: { player: Player; titlePrefix: string }) {
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

function HistoryPlayerCard({ player, titlePrefix, handPrice }: { player: Player; titlePrefix: string; handPrice?: MoneyJson }) {
  const [expanded, setExpanded] = useState(false);
  const finalAmount = BigInt(player.finalAmount);
  const winner = finalAmount > 0n;
  const loser = finalAmount < 0n;
  const finalTone = moneyTone(player.finalAmount);
  const feeTotal = BigInt(player.roomFeeShare) + BigInt(player.otherFeeShare);
  const final = finalMoneyPresentation(player.finalAmount);
  const afterFeeDirection = BigInt(player.afterFeeProfit) > 0n ? '应收' : BigInt(player.afterFeeProfit) < 0n ? '应付' : '收支';
  const detailId = `history-calculation-${player.playerId}`;
  const toggleVerb = expanded ? '收起' : '展开';
  const hasBankTransfer = finalAmount !== 0n;
  const hasExpense = BigInt(player.rakeAmount) !== 0n;
  const hasDataDetails = BigInt(player.buyIn) !== 0n || BigInt(player.cashOut) !== 0n;
  const hasCalculationDetails = BigInt(player.rawProfit) !== 0n || feeTotal !== 0n || BigInt(player.afterFeeProfit) !== 0n || BigInt(player.rakeAmount) !== 0n || finalAmount !== 0n;
  const hasExpandableDetails = hasDataDetails || hasCalculationDetails;

  return <article aria-label={`${player.nickname}个人明细`} className={`settlement-player-card settlement-player-card--history ${winner ? 'settlement-player-card--winner' : loser ? 'settlement-player-card--loser' : 'settlement-player-card--neutral'}`}>
    <header className="history-player-header">
      <div className="history-player-identity"><UserAvatar nickname={player.nickname} avatarKind={player.avatarKind} avatarValue={player.avatarValue} label={`${player.nickname}的当前头像`} /><div><span className="seat-number">座位 {player.seatNo}</span><h3>{titlePrefix}{player.nickname}</h3></div></div>
      <strong className={`history-actual money--${finalTone}`}>{winner ? '本场实际盈利' : loser ? '本场实际亏损' : '本场实际收支'} {formatSignedMoney(player.finalAmount)}</strong>
    </header>

    {(hasBankTransfer || hasExpense) && <dl className="history-personal-summary">
      {hasBankTransfer && <div><dt>{winner ? '银行应付' : '银行应收'}</dt><dd className={`money--${finalTone}`}>{formatSignedPoints(winner ? player.afterFeeProfit : player.finalAmount)}</dd></div>}
      {hasExpense && <div><dt>经费</dt><dd className="rake-value">{formatSignedPoints((-BigInt(player.rakeAmount)).toString())}</dd></div>}
    </dl>}

    {hasExpandableDetails && <button type="button" className="history-detail-toggle" aria-expanded={expanded} aria-controls={detailId} aria-label={`${toggleVerb}${player.nickname}的计算明细`} onClick={() => setExpanded((value) => !value)}><span aria-hidden="true">{toggleVerb}计算明细</span><span className="history-detail-chevron" aria-hidden="true">{expanded ? '⌃' : '⌄'}</span></button>}
    {expanded && hasExpandableDetails && <div id={detailId} className="history-detail-panel">
      {hasDataDetails && <section><h4>本局数据</h4><dl className="history-data-grid">
        {BigInt(player.buyIn) !== 0n && <DetailCell label="买入手数" value={purchasedHands(player.buyIn, handPrice)} />}
        {BigInt(player.buyIn) !== 0n && <DetailCell label="买入金额" value={formatUnsignedMoney(player.buyIn)} />}
        {BigInt(player.cashOut) !== 0n && <DetailCell label="最终剩余" value={formatUnsignedMoney(player.cashOut)} />}
      </dl></section>}
      {hasCalculationDetails && <section><h4>金额计算</h4><dl className="history-calculation-grid">
        {BigInt(player.rawProfit) !== 0n && <DetailCell label="牌局盈亏" value={formatSignedMoney(player.rawProfit)} tone={moneyTone(player.rawProfit)} />}
        {feeTotal !== 0n && <DetailCell label="费用扣减" value={signedDeduction(feeTotal)} tone="expense" />}
        {BigInt(player.afterFeeProfit) !== 0n && <DetailCell label={`费用后盈亏 · 抽成前${afterFeeDirection}`} value={formatSignedMoney(player.afterFeeProfit)} tone={moneyTone(player.afterFeeProfit)} />}
        {BigInt(player.rakeAmount) !== 0n && <DetailCell label="抽成扣减" value={signedDeduction(BigInt(player.rakeAmount))} tone="rake" />}
        {finalAmount !== 0n && <DetailCell label={`最终金额 · ${final.label}`} value={formatSignedMoney(player.finalAmount)} tone={final.tone} />}
      </dl></section>}
    </div>}
  </article>;
}

export function SettlementPlayerCard({ player, titlePrefix = '', mode = 'preview', handPrice }: { player: Player; titlePrefix?: string; mode?: 'preview' | 'history'; handPrice?: MoneyJson }) {
  return mode === 'history'
    ? <HistoryPlayerCard player={player} titlePrefix={titlePrefix} handPrice={handPrice} />
    : <PreviewPlayerCard player={player} titlePrefix={titlePrefix} />;
}
