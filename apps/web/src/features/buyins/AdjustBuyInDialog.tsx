import type { BuyinEventResponse } from '@poker/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { isDefinitiveMutationRejection } from '../../api/http-client.js';
import { scorekeeperApi } from '../../api/resources.js';
import { Button } from '../../components/Button.js';
import { Modal } from '../../components/Modal.js';
import { Toast } from '../../components/Toast.js';

interface PendingAdjust {
  newHands: number;
  idempotencyKey: string;
}

function validHands(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 99 ? parsed : null;
}

export function AdjustBuyInDialog({
  gameId,
  playerId,
  currentHands,
  open,
  canWrite,
  signal,
  onClose,
  onSuccess
}: {
  gameId: string;
  playerId: string;
  currentHands: number;
  open: boolean;
  canWrite: boolean;
  signal?: AbortSignal;
  onClose: () => void;
  onSuccess: (result: BuyinEventResponse) => void;
}) {
  const [handsInput, setHandsInput] = useState(String(currentHands));
  const [pending, setPending] = useState<PendingAdjust | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setHandsInput(String(currentHands));
    if (!open) {
      setPending(null);
      setBusy(false);
      setUncertain(false);
      setError(null);
    }
  }, [currentHands, open]);

  if (!open) return null;
  const parsedHands = validHands(handsInput);
  const displayedHands = pending?.newHands ?? parsedHands;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !canWrite || signal?.aborted) return;
    const newHands = pending?.newHands ?? validHands(handsInput);
    if (newHands === null) {
      setError('请输入 0–99 手');
      return;
    }
    const request = pending ?? {
      newHands,
      idempotencyKey: crypto.randomUUID().toLowerCase()
    };
    setPending(request);
    setBusy(true);
    setError(null);
    try {
      const result = await scorekeeperApi.adjustLatestBuyIn(gameId, playerId, request, signal);
      if (signal?.aborted) return;
      setPending(null);
      setUncertain(false);
      onSuccess(result);
      onClose();
    } catch (reason) {
      if (signal?.aborted) return;
      if (isDefinitiveMutationRejection(reason)) {
        setPending(null);
        setUncertain(false);
        setError(reason.message);
      } else {
        setUncertain(true);
        setError('服务器结果未知，请使用相同请求重试，避免重复更正。');
      }
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  };

  const closeSafely = () => {
    if (!busy && !uncertain) onClose();
  };

  return (
    <Modal title="更正最后一笔购买" onClose={closeSafely}>
      <form className="modal-body adjust-dialog" noValidate onSubmit={(event) => void submit(event)}>
        <p className="adjust-summary">当前记录 <strong>{currentHands} 手</strong></p>
        <label className="field">更正后手数
          <input
            aria-label="更正后手数"
            type="number"
            inputMode="numeric"
            min="0"
            max="99"
            step="1"
            value={handsInput}
            disabled={busy || pending !== null || !canWrite}
            onChange={(event) => { setHandsInput(event.target.value); setError(null); }}
          />
          <small>允许 0–99 手；改为 0 会追加一笔冲正记录，不删除原记录。</small>
        </label>
        {error !== null && <Toast tone="error" message={error} />}
        <Button
          type="submit"
          unsafe
          disabled={busy || !canWrite}
          aria-label={uncertain ? '使用同一请求重试' : displayedHands === null ? '确认更正' : `确认更正为 ${displayedHands} 手`}
        >
          {busy ? '正在确认…' : uncertain ? '使用同一请求重试' : displayedHands === null ? '确认更正' : `确认更正为 ${displayedHands} 手`}
        </Button>
        <Button variant="ghost" disabled={busy || uncertain} onClick={closeSafely}>取消</Button>
      </form>
    </Modal>
  );
}
