import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/http-client.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Toast } from '../../components/Toast.js';

export function ChangePasswordPage() {
  const { changePassword, logout } = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await changePassword({ currentPassword, newPassword });
      navigate('/', { replace: true });
    } catch (reason) {
      setError(reason instanceof ApiError && reason.code === 'VALIDATION_ERROR' ? '请检查密码格式' : '修改失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  return <main className="auth-page"><h1>德州计分</h1><Card><h2>修改初始密码</h2><p>为保护账户，请先设置新密码。</p><form className="auth-form" onSubmit={submit}>
    {error !== null && <Toast tone="error" message={error} />}
    <label className="field" htmlFor="current-password">当前密码<input id="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label>
    <label className="field" htmlFor="new-password">新密码<input id="new-password" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
    <Button type="submit" unsafe disabled={submitting}>{submitting ? '保存中…' : '保存新密码'}</Button>
    <Button variant="ghost" unsafe onClick={() => void logout()}>退出登录</Button>
  </form></Card></main>;
}
