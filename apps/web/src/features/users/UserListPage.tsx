import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { UserResponse } from '@poker/contracts';
import { mutationMessage, scorekeeperApi } from '../../api/resources.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Modal } from '../../components/Modal.js';
import { Toast } from '../../components/Toast.js';

const roleLabel = { SUPER_ADMIN: '超级管理员', ADMIN: '管理员', USER: '普通用户' } as const;

export function UserListPage() {
  const { user: actor } = useAuth();
  const [users, setUsers] = useState<UserResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<UserResponse | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<UserResponse | null>(null);
  const [restoreNickname, setRestoreNickname] = useState('');
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [resetAvatarTarget, setResetAvatarTarget] = useState<UserResponse | null>(null);
  const [resetAvatarError, setResetAvatarError] = useState<string | null>(null);
  const [resettingAvatar, setResettingAvatar] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await scorekeeperApi.listUsers();
      setUsers(response.users);
    } catch (reason) {
      setError(mutationMessage(reason, '用户列表加载失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function deleteUser(target: UserResponse) {
    setConfirmDelete(null);
    setError(null);
    try {
      await scorekeeperApi.deleteUser(target.id);
      await load();
    } catch (reason) {
      setError(mutationMessage(reason, '删除用户失败'));
    }
  }

  function openRestore(target: UserResponse) {
    setRestoreTarget(target);
    setRestoreNickname(target.nickname);
    setRestoreError(null);
  }

  async function restoreUser() {
    if (restoreTarget === null) return;
    setRestoreError(null);
    setRestoring(true);
    try {
      await scorekeeperApi.restoreUser(restoreTarget.id, restoreNickname.trim() || undefined);
      setRestoreTarget(null);
      await load();
    } catch (reason) {
      setRestoreError(mutationMessage(reason, '恢复用户失败，请检查昵称后重试'));
    } finally {
      setRestoring(false);
    }
  }

  async function resetAvatar() {
    if (resetAvatarTarget === null) return;
    setResetAvatarError(null);
    setResettingAvatar(true);
    try {
      await scorekeeperApi.resetAvatar(resetAvatarTarget.id);
      setResetAvatarTarget(null);
      await load();
    } catch (reason) {
      setResetAvatarError(mutationMessage(reason, '重置头像失败，请稍后重试'));
    } finally {
      setResettingAvatar(false);
    }
  }

  return <div className="page-stack">
    <div className="section-heading"><div className="page-title"><span className="section-kicker">TEAM</span><h2>用户管理</h2><p>账号共 {users.length} 个</p></div><Link className="compact-link" to="/users/new">创建用户</Link></div>
    {error !== null && <Toast tone="error" message={error} />}
    {loading ? <p className="muted">正在加载用户…</p> : <div className="card-list">{users.map((target) => {
      const canEdit = actor?.role === 'SUPER_ADMIN' || target.role === 'USER';
      const canResetAvatar = target.deletedAt === null && (actor?.role === 'SUPER_ADMIN' || (actor?.role === 'ADMIN' && target.role === 'USER'));
      return <Card className="user-card" key={target.id}>
        <div className="user-card-main"><img src={target.avatarKind === 'PRESET' ? `/avatars/${target.avatarValue}.webp` : `/avatars/uploads/${target.avatarValue}`} alt="" /><div><strong>{target.nickname}</strong><span>@{target.username}</span></div><span className="role-badge">{roleLabel[target.role]}</span></div>
        <div className="user-meta"><span className={target.deletedAt ? 'status-dot status-dot--off' : 'status-dot'}>{target.deletedAt ? '已删除' : target.isActive ? '已启用' : '已停用'}</span><span>{target.rakeEnabled ? '参与抽成' : '不抽成'}</span></div>
        <div className="inline-actions">
          {canEdit && target.deletedAt === null && <Link className="secondary-link" to={`/users/${encodeURIComponent(target.id)}/edit`}>编辑</Link>}
          {canResetAvatar && <Button variant="secondary" unsafe onClick={() => { setResetAvatarTarget(target); setResetAvatarError(null); }}>重置头像</Button>}
          {actor?.role === 'SUPER_ADMIN' && target.deletedAt === null && <Button variant="danger" unsafe onClick={() => setConfirmDelete(target)}>删除</Button>}
          {actor?.role === 'SUPER_ADMIN' && target.deletedAt !== null && <Button variant="secondary" unsafe onClick={() => openRestore(target)}>恢复</Button>}
        </div>
      </Card>;
    })}</div>}
    {confirmDelete !== null && <Modal title="确认删除用户" onClose={() => setConfirmDelete(null)}><div className="modal-body"><p>删除 <strong>{confirmDelete.nickname}</strong> 后会立即撤销其会话；历史战绩仍会保留。</p><div className="button-stack"><Button variant="danger" unsafe onClick={() => void deleteUser(confirmDelete)}>确认删除</Button><Button variant="ghost" onClick={() => setConfirmDelete(null)}>取消</Button></div></div></Modal>}
    {restoreTarget !== null && <Modal title="恢复用户" onClose={() => { if (!restoring) setRestoreTarget(null); }}><div className="modal-body">
      <p>恢复 <strong>@{restoreTarget.username}</strong>。如原昵称已被占用，可在这里改成新昵称。</p>
      <label className="field"><span>恢复后的昵称</span><input value={restoreNickname} maxLength={32} onChange={(event) => setRestoreNickname(event.target.value)} disabled={restoring} /></label>
      {restoreError !== null && <Toast tone="error" message={restoreError} />}
      <div className="button-stack"><Button unsafe disabled={restoring || restoreNickname.trim().length === 0} onClick={() => void restoreUser()}>{restoring ? '正在恢复…' : '确认恢复'}</Button><Button variant="ghost" disabled={restoring} onClick={() => setRestoreTarget(null)}>取消</Button></div>
    </div></Modal>}
    {resetAvatarTarget !== null && <Modal title="确认重置头像" onClose={() => { if (!resettingAvatar) setResetAvatarTarget(null); }}><div className="modal-body">
      <p>确认将 <strong>{resetAvatarTarget.nickname}</strong> 的头像恢复为系统默认头像？</p>
      {resetAvatarError !== null && <Toast tone="error" message={resetAvatarError} />}
      <div className="button-stack"><Button variant="danger" unsafe disabled={resettingAvatar} onClick={() => void resetAvatar()}>{resettingAvatar ? '正在重置…' : '确认重置'}</Button><Button variant="ghost" disabled={resettingAvatar} onClick={() => setResetAvatarTarget(null)}>取消</Button></div>
    </div></Modal>}
  </div>;
}
