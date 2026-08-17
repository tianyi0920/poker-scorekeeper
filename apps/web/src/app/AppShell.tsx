import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.js';
import { Button } from '../components/Button.js';
import { useOnlineStatus } from '../hooks/useOnlineStatus.js';

export function OfflineBanner() {
  const online = useOnlineStatus();
  return !online ? <div className="offline-banner" role="status">当前离线，写入操作已禁用。</div> : null;
}

export function AppShell() {
  const { user, logout } = useAuth();
  return <div className="app-shell">
    <header className="app-header"><div><span className="eyebrow">MIDNIGHT TABLE</span><h1>德州计分</h1></div><Button variant="ghost" unsafe aria-label="退出登录" onClick={() => void logout()}>退出</Button></header>
    <main className="app-content"><p className="welcome">晚上好，{user?.nickname}</p><Outlet /></main>
    <nav className="bottom-nav" aria-label="主导航">
      <NavLink to="/" end>首页</NavLink>
      <NavLink to="/history">战绩</NavLink>
      <NavLink to="/profile">我的</NavLink>
    </nav>
  </div>;
}
