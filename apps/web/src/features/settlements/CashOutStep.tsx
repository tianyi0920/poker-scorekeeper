import type { SettlementDraftDto } from '@poker/contracts';
import { signedMoney } from './SettlementPlayerCard.js';

function profitTone(value: string): string { const money = BigInt(value); return money > 0n ? 'money--positive' : money < 0n ? 'money--negative' : 'money--neutral'; }

export function CashOutStep({ draft, onChange }: { draft: SettlementDraftDto; onChange: (playerId: string, value: string) => void }) {
  const buyIn = draft.players.reduce((sum, player) => sum + BigInt(player.buyIn), 0n);
  const cashOut = Object.values(draft.payload.cashOutByPlayerId).reduce((sum, value) => sum + (value === '' ? 0n : BigInt(value)), 0n);
  const difference = buyIn - cashOut;
  return <section className="wizard-step" aria-label="带走金额">
    <div className="settlement-total-strip"><span>总买入 <strong>¥{buyIn.toString()}</strong></span><span>已录入 <strong>¥{cashOut.toString()}</strong></span><strong className={difference === 0n ? 'money--positive' : 'money--negative'}>{difference === 0n ? '已平衡' : `${difference > 0n ? '还差' : '超出'} ¥${(difference < 0n ? -difference : difference).toString()}`}</strong></div>
    <div className="card-list">{draft.players.map((player) => <label className="cashout-row" key={player.playerId}>
      <span><strong>{player.nickname}</strong><small>买入 ¥{player.buyIn}</small><strong className={`raw-profit ${profitTone(player.rawProfit)}`}>牌局盈亏 {signedMoney(player.rawProfit)}</strong></span>
      <input aria-label={`${player.nickname}的带走金额`} inputMode="numeric" pattern="[0-9]*" value={draft.payload.cashOutByPlayerId[player.playerId] ?? ''} onChange={(event) => onChange(player.playerId, event.target.value.replace(/[^0-9]/g, ''))} />
    </label>)}</div>
  </section>;
}
