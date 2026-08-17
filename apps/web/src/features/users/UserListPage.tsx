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

  async function restoreUser(target: UserResponse) {
    setError(null);
    try {
      await scorekeeperApi.restoreUser(target.id);
      await load();
    } catch (reason) {
      setError(mutationMessage(reason, '恢复用户失败；如果昵称已被占用，请进入编辑页填写新昵称'));
    }
  }

  return <div className="page-stack">
    <div className="section-heading"><div className="page-title"><span className="section-kicker">TEAM</span><h2>用户管理</h2><p>账号共 {users.length} 个</p></div><Link className="compact-link" to="/users/new">创建用户</Link></div>
    {error !== null && <Toast tone="error" message={error} />}
    {loading ? <p className="muted">正在加载用户…</p> : <div className="card-list">{users.map((target) => {
      const canEdit = actor?.role === 'SUPER_ADMIN' || target.role === 'USER';
      return <Card className="user-card" key={target.id}>
        <div className="user-card-main"><img src={target.avatarKind === 'PRESET' ? `/avatars/${target.avatarValue}.webp` : `/avatars/uploads/${target.avatarValue}`} alt="" /><div><strong>{target.nickname}</strong><span>@{target.username}</span></div><span className="role-badge">{roleLabel[target.role]}</span></div>
        <div className="user-meta"><span className={target.deletedAt ? 'status-dot status-dot--off' : 'status-dot'}>{target.deletedAt ? '已删除' : target.isActive ? '已启用' : '已停用'}</span><span>{target.rakeEnabled ? '参与抽成' : '不抽成'}</span></div>
        <div className="inline-actions">
          {canEdit && target.deletedAt === null && <Link className="secondary-link" to={`/users/${encodeURIComponent(target.id)}/edit`}>编辑</Link>}
          {actor?.role === 'SUPER_ADMIN' && target.deletedAt === null && <Button variant="danger" unsafe onClick={() => setConfirmDelete(target)}>删除</Button>}
          {actor?.role === 'SUPER_ADMIN' && target.deletedAt !== null && <Button variant="secondary" unsafe onClick={() => void restoreUser(target)}>恢复</Button>}
        </div>
      </Card>;
    })}</div>}
    {confirmDelete !== null && <Modal title="确认删除用户" onClose={() => setConfirmDelete(null)}><div className="modal-body"><p>删除 <strong>{confirmDelete.nickname}</strong> 后会立即撤销其会话；历史战绩仍会保留。</p><div className="button-stack"><Button variant="danger" unsafe onClick={() => void deleteUser(confirmDelete)}>确认删除</Button><Button variant="ghost" onClick={() => setConfirmDelete(null)}>取消</Button></div></div></Modal>}
  </div>;
}
