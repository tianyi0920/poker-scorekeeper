import type { SettlementDraftDto, SettlementDraftPayload } from '@poker/contracts';
import { signedMoney } from './SettlementPlayerCard.js';

function FeeCandidates({ kind, draft, selected, onToggle }: { kind: '房费' | '其他费用'; draft: SettlementDraftDto; selected: string[]; onToggle: (playerId: string) => void }) {
  return <fieldset className="fee-candidates"><legend>{kind}分摊人</legend>{draft.players.map((player) => <label key={player.playerId} className="fee-candidate"><input type="checkbox" checked={selected.includes(player.playerId)} onChange={() => onToggle(player.playerId)} aria-label={`${kind}：${player.nickname}，牌局盈亏 ${signedMoney(player.rawProfit)}`} /><span><strong>{player.nickname}</strong><small>牌局盈亏 {signedMoney(player.rawProfit)}</small></span></label>)}</fieldset>;
}

export function ExpenseStep({ draft, onChange }: { draft: SettlementDraftDto; onChange: (payload: SettlementDraftPayload) => void }) {
  const payload = draft.payload;
  const change = (patch: Partial<SettlementDraftPayload>) => onChange({ ...payload, ...patch });
  const toggle = (field: 'roomPayerIds' | 'otherPayerIds', playerId: string) => change({ [field]: payload[field].includes(playerId) ? payload[field].filter((id) => id !== playerId) : [...payload[field], playerId] });
  return <section className="wizard-step" aria-label="费用分摊">
    <label className="field">房费（元）<input inputMode="numeric" value={payload.roomFee} onChange={(event) => change({ roomFee: event.target.value.replace(/[^0-9]/g, '') || '0' })} /></label>
    <FeeCandidates kind="房费" draft={draft} selected={payload.roomPayerIds} onToggle={(id) => toggle('roomPayerIds', id)} />
    <label className="field">其他费用（元）<input inputMode="numeric" value={payload.otherFee} onChange={(event) => change({ otherFee: event.target.value.replace(/[^0-9]/g, '') || '0' })} /></label>
    {payload.otherFee !== '0' && <label className="field">其他费用说明<input value={payload.otherFeeNote} maxLength={100} onChange={(event) => change({ otherFeeNote: event.target.value })} /></label>}
    <FeeCandidates kind="其他费用" draft={draft} selected={payload.otherPayerIds} onToggle={(id) => toggle('otherPayerIds', id)} />
  </section>;
}
