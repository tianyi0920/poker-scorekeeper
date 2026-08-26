import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider.js';
import { Card } from '../../components/Card.js';
import { AvatarPicker, type AvatarReference } from './AvatarPicker.js';

export function ProfilePage() {
  const { user, refreshSession } = useAuth();
  const currentAvatar: AvatarReference | null = user
    ? { kind: user.avatarKind, value: user.avatarValue }
    : null;
  const handleAvatarChanged = async () => {
    await refreshSession();
  };
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';
  return <div className="page-stack">
    <div className="page-title"><span className="section-kicker">个人中心</span><h2>我的</h2><p>{user?.nickname} · @{user?.username}</p></div>
    <Card className="profile-identity-card"><AvatarPicker nickname={user?.nickname ?? '用户'} currentAvatar={currentAvatar} onChanged={handleAvatarChanged} /></Card>
    <Card className="menu-card tools-menu-card"><h3>工具</h3><Link to="/tools/equity"><span><strong>胜率计算器</strong><small>2–9 人 · 翻牌前 / 翻牌 / 转牌 / 河牌</small></span><span aria-hidden="true">→</span></Link></Card>
    <Card className="menu-card"><h3>账户</h3><Link to="/change-password">修改密码 <span aria-hidden="true">→</span></Link></Card>
    {isAdmin && <Card className="menu-card"><h3>管理</h3><Link to="/users">用户管理 <span aria-hidden="true">→</span></Link>{user?.role === 'SUPER_ADMIN' && <><Link to="/games/manage">对局管理 <span aria-hidden="true">→</span></Link><Link to="/settings/rake">抽成设置 <span aria-hidden="true">→</span></Link></>}</Card>}
  </div>;
}
