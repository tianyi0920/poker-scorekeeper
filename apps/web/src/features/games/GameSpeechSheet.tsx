import { useEffect, useId, useRef, useState } from 'react';
import { mutationMessage } from '../../api/resources.js';
import { Button } from '../../components/Button.js';

export function GameSpeechSheet({
  open,
  disabled,
  onClose,
  onSubmit
}: {
  open: boolean;
  disabled: boolean;
  onClose: () => void;
  onSubmit: (text: string) => Promise<void>;
}) {
  const titleId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose, open, submitting]);

  if (!open) return null;
  const trimmed = draft.trim();

  const send = async () => {
    if (disabled || submitting || trimmed.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      setDraft('');
      onClose();
    } catch (reason) {
      setError(mutationMessage(reason, '发送失败，请重试'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="speech-sheet-backdrop" role="presentation" onMouseDown={() => { if (!submitting) onClose(); }}>
      <section
        className="speech-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header><h2 id={titleId}>发言</h2><button type="button" className="icon-button" aria-label="关闭" disabled={submitting} onClick={onClose}>×</button></header>
        <label htmlFor={`${titleId}-input`}>发言内容</label>
        <textarea
          ref={inputRef}
          id={`${titleId}-input`}
          value={draft}
          maxLength={120}
          disabled={disabled || submitting}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="说点什么…"
        />
        <div className="speech-sheet-meta"><span>{draft.length}/120</span>{error !== null && <span role="alert">{error}</span>}</div>
        <Button unsafe disabled={disabled || submitting || trimmed.length === 0} onClick={() => void send()}>
          {submitting ? '发送中…' : '发送'}
        </Button>
      </section>
    </div>
  );
}
