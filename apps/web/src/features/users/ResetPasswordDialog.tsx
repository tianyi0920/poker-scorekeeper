import { useCallback, useState, type FormEvent } from 'react';
import { mutationMessage, scorekeeperApi } from '../../api/resources.js';
import { Button } from '../../components/Button.js';
import { Modal } from '../../components/Modal.js';
import { Toast } from '../../components/Toast.js';
import { DEFAULT_TEMPORARY_PASSWORD } from './default-temporary-password.js';

export function ResetPasswordDialog({ userId, nickname, onClose }: { userId: string; nickname: string; onClose: () => void }) {
  const [password, setPassword] = useState(DEFAULT_TEMPORARY_PASSWORD);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const stableClose = useCallback(onClose, [onClose]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 8 || password.length > 128) {
      setError('临时密码长度需为 8–128 位');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await scorekeeperApi.resetPassword(userId, password);
      setPassword('');
      setDone(true);
    } catch (reason) {
      setError(mutationMessage(reason, '重置密码失败，请稍后重试'));
    } finally {
      setSubmitting(false);
    }
  }

  return <Modal title={`重置 ${nickname} 的密码`} onClose={stableClose}><div className="modal-body">
    {done ? <><Toast tone="success" message="密码已重置，对方下次登录必须修改密码。" /><Button onClick={onClose}>完成</Button></> : <form className="form-stack" onSubmit={submit}>
      {error !== null && <Toast tone="error" message={error} />}
      <label className="field" htmlFor="temporary-password">新临时密码<input id="temporary-password" type="password" autoComplete="new-password" minLength={8} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
      <Button type="submit" unsafe disabled={submitting}>{submitting ? '重置中…' : '确认重置密码'}</Button>
    </form>}
  </div></Modal>;
}
