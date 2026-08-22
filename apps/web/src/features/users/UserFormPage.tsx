import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { AuthRole, UserResponse } from '@poker/contracts';
import { mutationMessage, scorekeeperApi } from '../../api/resources.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Toast } from '../../components/Toast.js';
import { DEFAULT_TEMPORARY_PASSWORD } from './default-temporary-password.js';
import { ResetPasswordDialog } from './ResetPasswordDialog.js';

const roleLabels: Record<AuthRole, string> = {
  SUPER_ADMIN: '超级管理员', ADMIN: '管理员', USER: '普通用户'
};

export function UserFormPage({ mode }: { mode: 'create' | 'edit' }) {
  const { user: actor } = useAuth();
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const [target, setTarget] = useState<UserResponse | null>(null);
  const [username, setUsername] = useState('');
  const [nickname, setNickname] = useState('');
  const [initialPassword, setInitialPassword] = useState(DEFAULT_TEMPORARY_PASSWORD);
  const [role, setRole] = useState<AuthRole>('USER');
  const [rakeEnabled, setRakeEnabled] = useState(true);
  const [isActive, setIsActive] = useState(true);
  const [loading, setLoading] = useState(mode === 'edit');
  const [submitting, setSubmitting] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeReset = useCallback(() => setResetOpen(false), []);

  useEffect(() => {
    if (mode !== 'edit') return;
    let active = true;
    void scorekeeperApi.listUsers().then(({ users }) => {
      const found = users.find((item) => item.id === id) ?? null;
      if (!active) return;
      setTarget(found);
      if (found !== null) {
        setNickname(found.nickname);
        setRole(found.role);
        setRakeEnabled(found.rakeEnabled);
        setIsActive(found.isActive);
      }
    }).catch((reason) => active && setError(mutationMessage(reason, '用户资料加载失败')))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [id, mode]);

  const canManageTarget = mode === 'create' || actor?.role === 'SUPER_ADMIN' || target?.role === 'USER';
  const roleChoices: AuthRole[] = actor?.role === 'SUPER_ADMIN'
    ? ['SUPER_ADMIN', 'ADMIN', 'USER']
    : ['USER'];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === 'create') {
        await scorekeeperApi.createUser({ username, nickname, initialPassword, role, rakeEnabled });
      } else if (target !== null) {
        await scorekeeperApi.updateUser(target.id, actor?.role === 'SUPER_ADMIN'
          ? { nickname, role, rakeEnabled, isActive }
          : { nickname, rakeEnabled });
      }
      navigate('/users');
    } catch (reason) {
      setError(mutationMessage(reason, mode === 'create' ? '创建用户失败' : '保存用户失败'));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <p className="muted">正在加载用户资料…</p>;
  if (mode === 'edit' && target === null) return <Toast tone="error" message="用户不存在或已无法管理" />;
  if (!canManageTarget) return <Card><Toast tone="error" message="你的角色不能编辑该账号" /><Link className="action-link" to="/users">返回用户列表</Link></Card>;

  return <div className="page-stack narrow-page">
    <div className="page-title"><span className="section-kicker">{mode === 'create' ? 'NEW MEMBER' : 'MEMBER PROFILE'}</span><h2>{mode === 'create' ? '创建用户' : `编辑 ${target?.nickname ?? ''}`}</h2><p>权限选项会根据你的角色自动收窄。</p></div>
    <Card><form className="form-stack" onSubmit={submit}>
      {error !== null && <Toast tone="error" message={error} />}
      {mode === 'create' && <label className="field" htmlFor="new-username">用户名<input id="new-username" minLength={3} maxLength={32} pattern="[A-Za-z0-9._-]+" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" required /></label>}
      <label className="field" htmlFor="user-nickname">昵称<input id="user-nickname" minLength={1} maxLength={20} value={nickname} onChange={(event) => setNickname(event.target.value)} required /></label>
      {mode === 'create' && <label className="field" htmlFor="initial-password">初始密码<input id="initial-password" type="password" minLength={8} maxLength={128} value={initialPassword} onChange={(event) => setInitialPassword(event.target.value)} autoComplete="new-password" required /></label>}
      {(mode === 'create' || actor?.role === 'SUPER_ADMIN') && <label className="field" htmlFor="user-role">角色<select id="user-role" value={role} onChange={(event) => setRole(event.target.value as AuthRole)}>{roleChoices.map((choice) => <option key={choice} value={choice}>{roleLabels[choice]}</option>)}</select></label>}
      <label className="toggle-row" htmlFor="user-rake"><span><strong>参与抽成</strong><small>对进行中结算实时生效</small></span><input id="user-rake" type="checkbox" checked={rakeEnabled} onChange={(event) => setRakeEnabled(event.target.checked)} /></label>
      {mode === 'edit' && actor?.role === 'SUPER_ADMIN' && <label className="toggle-row" htmlFor="user-active"><span><strong>启用账号</strong><small>停用会立即撤销该账号会话</small></span><input id="user-active" type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} /></label>}
      <Button type="submit" unsafe disabled={submitting}>{submitting ? '保存中…' : mode === 'create' ? '创建用户' : '保存修改'}</Button>
      {mode === 'edit' && <Button variant="secondary" unsafe onClick={() => setResetOpen(true)}>重置密码</Button>}
    </form></Card>
    {resetOpen && target !== null && <ResetPasswordDialog userId={target.id} nickname={target.nickname} onClose={closeReset} />}
  </div>;
}
