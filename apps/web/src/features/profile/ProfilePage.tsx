import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider.js';
import { Card } from '../../components/Card.js';
import { AvatarPicker, type AvatarReference } from './AvatarPicker.js';

export function ProfilePage() {
  const { user } = useAuth();
  const [avatar, setAvatar] = useState<AvatarReference | null>(null);
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';
  return <div className="page-stack">
    <div className="page-title"><span className="section-kicker">PROFILE</span><h2>我的</h2><p>{user?.nickname} · @{user?.username}</p></div>
    <Card><h3>头像</h3><AvatarPicker currentAvatar={avatar} onChanged={setAvatar} /></Card>
    <Card className="menu-card"><h3>账户</h3><Link to="/change-password">修改密码 <span aria-hidden="true">→</span></Link></Card>
    {isAdmin && <Card className="menu-card"><h3>管理</h3><Link to="/users">用户管理 <span aria-hidden="true">→</span></Link>{user?.role === 'SUPER_ADMIN' && <Link to="/settings/rake">抽成设置 <span aria-hidden="true">→</span></Link>}</Card>}
  </div>;
}
