import type { SettlementBreakdownDto } from '@poker/contracts';
import { Button } from '../../components/Button.js';
import { SettlementPlayerCard } from './SettlementPlayerCard.js';

function amount(value: string): string { return new Intl.NumberFormat('zh-CN').format(BigInt(value)); }

export function SettlementBreakdown({ breakdown, mode, onConfirm }: { breakdown: SettlementBreakdownDto; mode: 'preview' | 'history'; onConfirm?: () => void }) {
  return <section className="settlement-breakdown" aria-label={mode === 'history' ? '历史结算明细' : '结算预览'}>
    <div className="settlement-breakdown-total"><span>总买入 ¥{amount(breakdown.totals.buyIn)}</span><span>总带走 ¥{amount(breakdown.totals.cashOut)}</span><span>总房费 ¥{amount(breakdown.totals.roomFee)}</span><span>总其他费 ¥{amount(breakdown.totals.otherFee)}</span></div>
    <div className="card-list">{breakdown.players.map((player) => <SettlementPlayerCard key={player.playerId} player={player} />)}</div>
    {mode === 'preview' && <div className="irreversible-warning"><strong>不可逆操作</strong><p>确认后将永久锁定本局结算，无法在页面中撤回。</p>{onConfirm && <Button variant="danger" unsafe onClick={onConfirm}>打开永久确认</Button>}</div>}
  </section>;
}
