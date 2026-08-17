import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/http-client.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Toast } from '../../components/Toast.js';

function messageFor(error: unknown): string {
  if (error instanceof ApiError && error.code === 'INVALID_CREDENTIALS') return '用户名或密码错误';
  if (error instanceof ApiError && error.code === 'TOO_MANY_REQUESTS') return '尝试次数过多，请稍后再试';
  return '登录失败，请稍后重试';
}

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const user = await login({ username, password });
      navigate(user.mustChangePassword ? '/change-password' : ((location.state as { from?: string } | null)?.from ?? '/'), { replace: true });
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setSubmitting(false);
    }
  }

  return <main className="auth-page"><h1>德州计分</h1><Card><h2>登录</h2><form className="auth-form" onSubmit={submit}>
    {error !== null && <Toast tone="error" message={error} />}
    <label className="field" htmlFor="username">用户名<input id="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
    <label className="field" htmlFor="password">密码<input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
    <Button type="submit" unsafe disabled={submitting}>{submitting ? '登录中…' : '登录'}</Button>
  </form></Card></main>;
}
