import type { SettlementDraftDto, SettlementDraftPayload, SettlementPreviewDto } from '@poker/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api/http-client.js';
import { scorekeeperApi } from '../../api/resources.js';
import { Button } from '../../components/Button.js';
import { Modal } from '../../components/Modal.js';
import { Toast } from '../../components/Toast.js';
import { useOnlineStatus } from '../../hooks/useOnlineStatus.js';
import { CashOutStep } from './CashOutStep.js';
import { ExpenseStep } from './ExpenseStep.js';
import { SettlementBreakdown } from './SettlementBreakdown.js';

type Step = 'cashout' | 'expense' | 'preview';
type SaveState = 'saved' | 'saving' | 'conflict';

function latestDraft(error: ApiError): SettlementDraftDto | null {
  const details = error.details;
  if (typeof details !== 'object' || details === null || !('latest' in details)) return null;
  return (details as { latest?: SettlementDraftDto }).latest ?? null;
}

export function SettlementWizardPage() {
  const { id: gameId = '' } = useParams();
  const navigate = useNavigate();
  const online = useOnlineStatus();
  const [draft, setDraft] = useState<SettlementDraftDto | null>(null);
  const [preview, setPreview] = useState<SettlementPreviewDto | null>(null);
  const [step, setStep] = useState<Step>('cashout');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [settingsConflict, setSettingsConflict] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);

  const applyDraft = useCallback((next: SettlementDraftDto, source: 'saved' | 'conflict' = 'saved') => {
    if (!mountedRef.current) return;
    setDraft(next);
    setPreview(next);
    setSaveState(source);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    setDraft(null); setPreview(null); setStep('cashout'); setLoadError(null); setConflictMessage(null);
    if (gameId === '') { setLoadError('对局不存在'); return () => { mountedRef.current = false; }; }
    void scorekeeperApi.settlementDraft(gameId).then((next) => {
      if (active) applyDraft(next);
    }).catch(() => { if (active) setLoadError('结算草稿暂时无法加载，请稍后重试'); });
    return () => { active = false; mountedRef.current = false; if (timerRef.current !== undefined) window.clearTimeout(timerRef.current); };
  }, [applyDraft, gameId]);

  const savePayload = useCallback(async (payload: SettlementDraftPayload, version: number) => {
    if (!online || gameId === '') return;
    try {
      const next = await scorekeeperApi.saveSettlementDraft(gameId, { version, payload });
      applyDraft(next);
    } catch (reason) {
      if (!(reason instanceof ApiError)) { if (mountedRef.current) setSaveState('conflict'); return; }
      if (reason.code === 'DRAFT_VERSION_CONFLICT' || reason.code === 'DRAFT_EDITOR_CONFLICT') {
        const latest = latestDraft(reason);
        if (latest !== null && mountedRef.current) {
          applyDraft(latest, 'conflict');
          setConflictMessage(`草稿已由${latest.editorNickname}更新，已替换为服务器版本。`);
        }
      } else if (mountedRef.current) setSaveState('conflict');
    }
  }, [applyDraft, gameId, online]);

  const scheduleSave = useCallback((payload: SettlementDraftPayload) => {
    if (draft === null || !draft.canEdit || !online) return;
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    setSaveState('saving'); setPreview(null); setSettingsConflict(false); setConflictMessage(null);
    const version = draft.version;
    timerRef.current = window.setTimeout(() => { timerRef.current = undefined; void savePayload(payload, version); }, 400);
  }, [draft, online, savePayload]);

  const updatePayload = (payload: SettlementDraftPayload) => {
    if (draft === null || !draft.canEdit || !online) return;
    setDraft({ ...draft, payload });
    scheduleSave(payload);
  };

  const requestPreview = async () => {
    if (draft === null || !online) return;
    setPreviewError(null);
    try {
      const next = await scorekeeperApi.previewSettlement(gameId, draft.payload);
      if (!mountedRef.current) return;
      setPreview(next); setSettingsConflict(false); setStep('preview');
    } catch { if (mountedRef.current) setPreviewError('无法生成服务器结算预览，请检查分摊后重试。'); }
  };

  const takeOver = async () => {
    if (!online || gameId === '') return;
    try { applyDraft(await scorekeeperApi.takeOverSettlementDraft(gameId)); setConflictMessage(null); }
    catch { setConflictMessage('暂时无法接管草稿，请稍后重试。'); }
  };

  const finalize = async () => {
    if (preview === null || preview.confirmationToken === null || settingsConflict || !online) return;
    setFinalizing(true);
    try {
      const detail = await scorekeeperApi.finalizeSettlement(gameId, { draftVersion: preview.draftVersion, settingsVersion: preview.settingsVersion, confirmationToken: preview.confirmationToken });
      if (mountedRef.current) navigate(`/history/${detail.game.id}`, { replace: true });
    } catch (reason) {
      if (!mountedRef.current) return;
      if (reason instanceof ApiError && reason.code === 'SETTINGS_VERSION_CONFLICT') {
        setSettingsConflict(true); setPreview(null); setPreviewError('抽成规则已变化，请重新核对'); setConfirmOpen(false); setStep('expense');
      } else setPreviewError('永久结算未完成，请稍后重试。');
    } finally { if (mountedRef.current) setFinalizing(false); }
  };

  if (draft === null) return <section className="page-stack"><p className="muted">正在加载结算草稿…</p>{loadError !== null && <Toast tone="error" message={loadError} />}</section>;
  const previewReady = preview?.previewReady === true;
  const writeAllowed = online && draft.canEdit;
  return <section className="page-stack settlement-wizard" aria-labelledby="settlement-title">
    <header className="page-title"><span className="section-kicker">SETTLEMENT WIZARD</span><h2 id="settlement-title">结算向导</h2><p>草稿由服务器保存；费用、抽成与最终金额均以服务端预览为准。</p></header>
    <div className="wizard-progress" aria-label="结算步骤"><span aria-current={step === 'cashout' ? 'step' : undefined}>1 带走</span><span aria-current={step === 'expense' ? 'step' : undefined}>2 费用</span><span aria-current={step === 'preview' ? 'step' : undefined}>3 核对</span></div>
    <div className="draft-status" role="status">{!online ? '当前离线，写入已禁用' : saveState === 'saving' ? '正在保存草稿…' : saveState === 'conflict' ? '草稿存在冲突' : '草稿已保存'}</div>
    {conflictMessage !== null && <Toast tone="error" message={conflictMessage} />}
    {!draft.canEdit && <Toast tone="info" message={`当前由${draft.editorNickname}编辑。${draft.canTakeOver ? '租约已到期，可接管。' : '请等待对方完成或租约到期。'}`} />}
    {draft.canTakeOver && <Button variant="secondary" unsafe onClick={() => void takeOver()}>接管结算草稿</Button>}
    {previewError !== null && <Toast tone="error" message={previewError} />}
    {step === 'cashout' && <><CashOutStep draft={draft} onChange={(playerId, value) => updatePayload({ ...draft.payload, cashOutByPlayerId: { ...draft.payload.cashOutByPlayerId, [playerId]: value } })} /><Button disabled={!previewReady || !writeAllowed} onClick={() => setStep('expense')}>下一步：费用分摊</Button></>}
    {step === 'expense' && <><ExpenseStep draft={draft} onChange={updatePayload} /><div className="inline-actions"><Button variant="ghost" onClick={() => setStep('cashout')}>返回带走金额</Button><Button unsafe disabled={!writeAllowed} onClick={() => void requestPreview()}>查看结算预览</Button></div></>}
    {step === 'preview' && preview !== null && <><SettlementBreakdown breakdown={preview} mode="preview" onConfirm={() => setConfirmOpen(true)} /><div className="inline-actions"><Button variant="ghost" onClick={() => setStep('expense')}>修改费用</Button><Button unsafe disabled={!writeAllowed} onClick={() => void requestPreview()}>重新生成预览</Button></div></>}
    <Link className="secondary-link" to={`/games/${gameId}`}>返回牌桌</Link>
    {confirmOpen && <Modal title="确认永久结算" onClose={() => { if (!finalizing) setConfirmOpen(false); }}><div className="modal-body"><Toast tone="error" message="此操作不可逆。请再次确认所有玩家的最终金额。" />{settingsConflict && <Toast tone="error" message="抽成规则已变化，请重新核对" />}<Button variant="danger" unsafe disabled={finalizing || settingsConflict || preview === null} onClick={() => void finalize()}>确认并永久锁定结算</Button><Button variant="ghost" disabled={finalizing} onClick={() => setConfirmOpen(false)}>返回核对</Button></div></Modal>}
  </section>;
}
