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
interface OperationContext { gameId: string; generation: number; }
interface PreviewBinding extends OperationContext { revision: number; draftVersion: number; }
interface WizardSession {
  generation: number; gameId: string; revision: number; draft: SettlementDraftDto | null; saved: SettlementDraftDto | null;
  pending: SettlementDraftPayload | null; timer?: number; runner: Promise<void> | null;
  saveAbort: AbortController | null; previewAbort: AbortController | null; finalizeAbort: AbortController | null; binding: PreviewBinding | null;
}

function latestDraft(error: ApiError): SettlementDraftDto | null {
  const details = error.details;
  if (typeof details !== 'object' || details === null || !('latest' in details)) return null;
  return (details as { latest?: SettlementDraftDto }).latest ?? null;
}

function sameBinding(left: PreviewBinding | null, right: PreviewBinding | null): boolean {
  return left !== null && right !== null && left.gameId === right.gameId && left.generation === right.generation && left.revision === right.revision && left.draftVersion === right.draftVersion;
}

export function SettlementWizardPage() {
  const { id: gameId = '' } = useParams(); const navigate = useNavigate(); const online = useOnlineStatus();
  const [draft, setDraft] = useState<SettlementDraftDto | null>(null); const [preview, setPreview] = useState<SettlementPreviewDto | null>(null); const [step, setStep] = useState<Step>('cashout'); const [saveState, setSaveState] = useState<SaveState>('saved');
  const [conflictMessage, setConflictMessage] = useState<string | null>(null); const [loadError, setLoadError] = useState<string | null>(null); const [previewError, setPreviewError] = useState<string | null>(null); const [confirmOpen, setConfirmOpen] = useState(false); const [settingsConflict, setSettingsConflict] = useState(false); const [finalizing, setFinalizing] = useState(false);
  const sessionRef = useRef<WizardSession>({ generation: 0, gameId: '', revision: 0, draft: null, saved: null, pending: null, runner: null, saveAbort: null, previewAbort: null, finalizeAbort: null, binding: null });
  const current = useCallback((context: OperationContext) => sessionRef.current.gameId === context.gameId && sessionRef.current.generation === context.generation, []);
  const clearPreview = useCallback(() => { const session = sessionRef.current; session.previewAbort?.abort(); session.previewAbort = null; session.binding = null; setPreview(null); setConfirmOpen(false); setSettingsConflict(false); }, []);

  const runSaveQueue = useCallback((context: OperationContext): Promise<void> => {
    const session = sessionRef.current;
    if (!current(context)) return Promise.resolve();
    if (session.runner !== null) return session.runner;
    session.runner = (async () => {
      while (current(context) && session.pending !== null) {
        const payload = session.pending; session.pending = null; const startRevision = session.revision; const base = session.saved;
        if (base === null || !base.canEdit) break;
        const controller = new AbortController(); session.saveAbort?.abort(); session.saveAbort = controller;
        try {
          const next = await scorekeeperApi.saveSettlementDraft(context.gameId, { version: base.version, payload }, controller.signal);
          if (!current(context) || controller.signal.aborted) return;
          session.saved = next;
          if (session.pending === null && session.revision === startRevision) { session.draft = next; setDraft(next); setPreview(next); setSaveState('saved'); }
        } catch (reason) {
          if (!current(context) || controller.signal.aborted) return;
          if (reason instanceof ApiError && (reason.code === 'DRAFT_VERSION_CONFLICT' || reason.code === 'DRAFT_EDITOR_CONFLICT')) {
            const latest = latestDraft(reason);
            if (latest !== null) { session.pending = null; session.draft = latest; session.saved = latest; session.revision += 1; clearPreview(); setDraft(latest); setSaveState('conflict'); setConflictMessage(`草稿已由${latest.editorNickname}更新，已替换为服务器版本。`); }
          } else setSaveState('conflict');
          return;
        } finally { if (session.saveAbort === controller) session.saveAbort = null; }
      }
    })().finally(() => { if (!current(context)) return; session.runner = null; if (session.pending !== null) void runSaveQueue(context); else if (session.saved !== null && session.draft === session.saved) setSaveState('saved'); });
    return session.runner;
  }, [clearPreview, current]);

  const flushSaves = useCallback(async (context: OperationContext): Promise<SettlementDraftDto | null> => {
    const session = sessionRef.current;
    if (session.timer !== undefined) { window.clearTimeout(session.timer); session.timer = undefined; }
    while (current(context) && (session.pending !== null || session.runner !== null)) { if (session.pending !== null) await runSaveQueue(context); else await session.runner; }
    return current(context) ? session.saved : null;
  }, [current, runSaveQueue]);

  useEffect(() => {
    const session = sessionRef.current; session.generation += 1; const context = { gameId, generation: session.generation };
    session.gameId = gameId; session.revision = 0; session.draft = null; session.saved = null; session.pending = null; session.binding = null;
    if (session.timer !== undefined) window.clearTimeout(session.timer); session.timer = undefined; session.saveAbort?.abort(); session.previewAbort?.abort(); session.finalizeAbort?.abort(); session.saveAbort = null; session.previewAbort = null; session.finalizeAbort = null;
    setDraft(null); setPreview(null); setStep('cashout'); setLoadError(null); setConflictMessage(null); setPreviewError(null); setConfirmOpen(false); setSettingsConflict(false); setFinalizing(false);
    if (gameId === '') { setLoadError('对局不存在'); return; }
    const controller = new AbortController();
    void scorekeeperApi.settlementDraft(gameId, controller.signal).then((next) => { if (!current(context) || controller.signal.aborted) return; session.draft = next; session.saved = next; setDraft(next); setPreview(next); setSaveState('saved'); }).catch(() => { if (current(context) && !controller.signal.aborted) setLoadError('结算草稿暂时无法加载，请稍后重试'); });
    return () => { controller.abort(); if (current(context)) { session.generation += 1; session.gameId = ''; if (session.timer !== undefined) window.clearTimeout(session.timer); session.saveAbort?.abort(); session.previewAbort?.abort(); session.finalizeAbort?.abort(); } };
  }, [current, gameId]);

  const updatePayload = (payload: SettlementDraftPayload) => {
    const session = sessionRef.current; const local = session.draft;
    if (local === null || !local.canEdit || !online || session.gameId !== gameId) return;
    session.revision += 1; session.draft = { ...local, payload }; session.pending = payload; clearPreview(); setDraft(session.draft); setSaveState('saving'); setConflictMessage(null);
    if (session.timer !== undefined) window.clearTimeout(session.timer);
    const context = { gameId, generation: session.generation }; session.timer = window.setTimeout(() => { session.timer = undefined; void runSaveQueue(context); }, 400);
  };

  const requestPreview = async () => {
    const session = sessionRef.current; const context = { gameId, generation: session.generation };
    if (session.draft === null || !online || !current(context)) return;
    const revision = session.revision; setPreviewError(null); clearPreview(); const saved = await flushSaves(context);
    if (saved === null || !current(context) || session.revision !== revision || session.draft !== saved) return;
    const controller = new AbortController(); session.previewAbort = controller;
    try {
      const next = await scorekeeperApi.previewSettlement(gameId, saved.payload, controller.signal);
      if (!current(context) || controller.signal.aborted || session.revision !== revision || session.saved?.version !== saved.version || next.draftVersion !== saved.version) return;
      session.binding = next.previewReady && next.confirmationToken !== null ? { ...context, revision, draftVersion: saved.version } : null; setPreview(next); setSettingsConflict(false); setStep('preview');
    } catch { if (current(context) && !controller.signal.aborted) setPreviewError('无法生成服务器结算预览，请检查分摊后重试。'); }
    finally { if (session.previewAbort === controller) session.previewAbort = null; }
  };

  const takeOver = async () => {
    const session = sessionRef.current; const context = { gameId, generation: session.generation }; if (!online || gameId === '' || !current(context)) return;
    const controller = new AbortController();
    try { const next = await scorekeeperApi.takeOverSettlementDraft(gameId, controller.signal); if (current(context) && !controller.signal.aborted) { session.draft = next; session.saved = next; clearPreview(); setDraft(next); setConflictMessage(null); } }
    catch { if (current(context) && !controller.signal.aborted) setConflictMessage('暂时无法接管草稿，请稍后重试。'); }
  };

  const finalize = async () => {
    const session = sessionRef.current; const binding = session.binding; const context = { gameId, generation: session.generation };
    if (preview === null || preview.confirmationToken === null || settingsConflict || !online || !sameBinding(binding, { ...context, revision: session.revision, draftVersion: session.saved?.version ?? -1 })) return;
    const controller = new AbortController(); session.finalizeAbort = controller; setFinalizing(true);
    try { const detail = await scorekeeperApi.finalizeSettlement(gameId, { draftVersion: preview.draftVersion, settingsVersion: preview.settingsVersion, confirmationToken: preview.confirmationToken }, controller.signal); if (current(context) && !controller.signal.aborted && sameBinding(session.binding, binding)) navigate(`/history/${detail.game.id}`, { replace: true }); }
    catch (reason) { if (!current(context) || controller.signal.aborted) return; if (reason instanceof ApiError && reason.code === 'SETTINGS_VERSION_CONFLICT') { clearPreview(); setPreviewError('抽成规则已变化，请重新核对'); setStep('expense'); } else setPreviewError('永久结算未完成，请稍后重试。'); }
    finally { if (current(context) && session.finalizeAbort === controller) { session.finalizeAbort = null; setFinalizing(false); } }
  };

  if (draft === null) return <section className="page-stack"><p className="muted">正在加载结算草稿…</p>{loadError !== null && <Toast tone="error" message={loadError} />}</section>;
  const session = sessionRef.current; const previewReady = preview?.previewReady === true; const previewCanConfirm = sameBinding(session.binding, { gameId, generation: session.generation, revision: session.revision, draftVersion: session.saved?.version ?? -1 }); const writeAllowed = online && draft.canEdit;
  return <section className="page-stack settlement-wizard" aria-labelledby="settlement-title">
    <header className="page-title"><span className="section-kicker">SETTLEMENT WIZARD</span><h2 id="settlement-title">结算向导</h2><p>草稿由服务器保存；费用、抽成与最终金额均以服务端预览为准。</p></header><div className="wizard-progress" aria-label="结算步骤"><span aria-current={step === 'cashout' ? 'step' : undefined}>1 带走</span><span aria-current={step === 'expense' ? 'step' : undefined}>2 费用</span><span aria-current={step === 'preview' ? 'step' : undefined}>3 核对</span></div><div className="draft-status" role="status">{!online ? '当前离线，写入已禁用' : saveState === 'saving' ? '正在保存草稿…' : saveState === 'conflict' ? '草稿存在冲突' : '草稿已保存'}</div>
    {conflictMessage !== null && <Toast tone="error" message={conflictMessage} />}{!draft.canEdit && <Toast tone="info" message={`当前由${draft.editorNickname}编辑。${draft.canTakeOver ? '租约已到期，可接管。' : '请等待对方完成或租约到期。'}`} />}{draft.canTakeOver && <Button variant="secondary" unsafe onClick={() => void takeOver()}>接管结算草稿</Button>}{previewError !== null && <Toast tone="error" message={previewError} />}
    {step === 'cashout' && <><CashOutStep draft={draft} onChange={(playerId, value) => updatePayload({ ...draft.payload, cashOutByPlayerId: { ...draft.payload.cashOutByPlayerId, [playerId]: value } })} /><Button disabled={!previewReady || !writeAllowed} onClick={() => setStep('expense')}>下一步：费用分摊</Button></>}
    {step === 'expense' && <><ExpenseStep draft={draft} onChange={updatePayload} /><div className="inline-actions"><Button variant="ghost" onClick={() => setStep('cashout')}>返回带走金额</Button><Button unsafe disabled={!writeAllowed} onClick={() => void requestPreview()}>查看结算预览</Button></div></>}
    {step === 'preview' && preview !== null && <><SettlementBreakdown breakdown={preview} mode="preview" onConfirm={previewCanConfirm ? () => setConfirmOpen(true) : undefined} /><div className="inline-actions"><Button variant="ghost" onClick={() => setStep('expense')}>修改费用</Button><Button unsafe disabled={!writeAllowed} onClick={() => void requestPreview()}>重新生成预览</Button></div></>}
    <Link className="secondary-link" to={`/games/${gameId}`}>返回牌桌</Link>{confirmOpen && <Modal title="确认永久结算" onClose={() => { if (!finalizing) setConfirmOpen(false); }}><div className="modal-body"><Toast tone="error" message="此操作不可逆。请再次确认所有玩家的最终金额。" /><Button variant="danger" unsafe disabled={finalizing || !previewCanConfirm} onClick={() => void finalize()}>确认并永久锁定结算</Button><Button variant="ghost" disabled={finalizing} onClick={() => setConfirmOpen(false)}>返回核对</Button></div></Modal>}
  </section>;
}
