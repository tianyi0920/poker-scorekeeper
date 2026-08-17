import type { BuyinEventResponse } from '@poker/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { scorekeeperApi } from '../../api/resources.js';
import { ApiError } from '../../api/http-client.js';
import { Button } from '../../components/Button.js';
import { Modal } from '../../components/Modal.js';
import { Toast } from '../../components/Toast.js';

const quickHands = [1, 2, 3, 5, 10] as const;

interface PendingBuy {
  hands: number;
  idempotencyKey: string;
}

function validHands(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 99 ? parsed : null;
}

export function BuyInSheet({
  gameId,
  handPrice,
  open,
  onClose,
  onSuccess
}: {
  gameId: string;
  handPrice: string;
  open: boolean;
  onClose: () => void;
  onSuccess: (result: BuyinEventResponse) => void;
}) {
  const [handsInput, setHandsInput] = useState('1');
  const [pending, setPending] = useState<PendingBuy | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setHandsInput('1');
      setPending(null);
      setBusy(false);
      setUncertain(false);
      setError(null);
    }
  }, [open]);

  if (!open) return null;
  const parsedHands = validHands(handsInput);
  const displayedHands = pending?.hands ?? parsedHands;
  const total = displayedHands === null ? null : BigInt(handPrice) * BigInt(displayedHands);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const hands = pending?.hands ?? validHands(handsInput);
    if (hands === null) {
      setError('请输入 1–99 手');
      return;
    }
    const request = pending ?? {
      hands,
      idempotencyKey: crypto.randomUUID().toLowerCase()
    };
    setPending(request);
    setBusy(true);
    setError(null);
    try {
      const result = await scorekeeperApi.buyIn(gameId, request);
      setPending(null);
      setUncertain(false);
      onSuccess(result);
      onClose();
    } catch (reason) {
      if (reason instanceof ApiError) {
        setPending(null);
        setUncertain(false);
        setError(reason.message);
      } else {
        setUncertain(true);
        setError('网络结果未知，请使用相同请求重试，避免重复购买。');
      }
    } finally {
      setBusy(false);
    }
  };

  const closeSafely = () => {
    if (!busy && !uncertain) onClose();
  };

  return (
    <Modal title="购买筹码" onClose={closeSafely}>
      <form className="modal-body sheet-body" noValidate onSubmit={(event) => void submit(event)}>
        <div className="sheet-price"><span>每手</span><strong>¥{handPrice}</strong></div>
        <div className="quick-hands" aria-label="快捷手数">
          {quickHands.map((hands) => (
            <button
              key={hands}
              type="button"
              className={handsInput === String(hands) ? 'quick-hand quick-hand--active' : 'quick-hand'}
              aria-label={`购买 ${hands} 手`}
              disabled={busy || pending !== null}
              onClick={() => { setHandsInput(String(hands)); setError(null); }}
            >
              <strong>{hands}</strong><span>手</span>
            </button>
          ))}
        </div>
        <label className="field">手动输入
          <input
            aria-label="购买手数"
            type="number"
            inputMode="numeric"
            min="1"
            max="99"
            step="1"
            value={handsInput}
            disabled={busy || pending !== null}
            onChange={(event) => { setHandsInput(event.target.value); setError(null); }}
          />
          <small>请输入 1–99 手</small>
        </label>
        {total !== null && <p className="sheet-total">本次金额 <strong>¥{total.toString()}</strong></p>}
        {error !== null && <Toast tone="error" message={error} />}
        <Button
          type="submit"
          unsafe
          disabled={busy}
          aria-label={uncertain ? '使用同一请求重试' : displayedHands === null ? '确认购买' : `确认购买 ${displayedHands} 手`}
        >
          {busy ? '正在确认…' : uncertain ? '使用同一请求重试' : displayedHands === null ? '确认购买' : `确认购买 ${displayedHands} 手`}
        </Button>
        <Button variant="ghost" disabled={busy || uncertain} onClick={closeSafely}>取消</Button>
        {uncertain && <small className="uncertain-note">为确保账目不重复，请先重试确认结果后再关闭。</small>}
      </form>
    </Modal>
  );
}
