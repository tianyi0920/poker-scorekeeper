import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.js';
import { Button } from '../components/Button.js';
import { useOnlineStatus } from '../hooks/useOnlineStatus.js';

export function OfflineBanner() {
  const online = useOnlineStatus();
  return !online ? <div className="offline-banner" role="status">当前离线，写入操作已禁用。</div> : null;
}

function isReservedGameRoute(pathname: string) {
  return /^\/games\/new(?:\/|$)/.test(pathname);
}

export function isFocusedGameRoute(pathname: string) {
  return /^\/games\/[^/]+(?:\/settlement)?\/?$/.test(pathname) && !isReservedGameRoute(pathname);
}

function isLiveGameRoute(pathname: string) {
  return /^\/games\/[^/]+\/?$/.test(pathname) && !isReservedGameRoute(pathname);
}

export function AppShell() {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const focused = isFocusedGameRoute(pathname);
  const liveGame = isLiveGameRoute(pathname);
  const shellClassName = ['app-shell', focused && 'app-shell--focus', liveGame && 'app-shell--game'].filter(Boolean).join(' ');
  return <div className={shellClassName}>
    <header className="app-header"><div><span className="eyebrow">MIDNIGHT TABLE</span><h1>德州计分</h1></div><Button variant="ghost" unsafe aria-label="退出登录" onClick={() => void logout()}>退出</Button></header>
    <main className="app-content"><p className="welcome">晚上好，{user?.nickname}</p><Outlet /></main>
    {!focused && <nav className="bottom-nav" aria-label="主导航">
      <NavLink to="/" end>首页</NavLink>
      <NavLink to="/history">战绩</NavLink>
      <NavLink to="/profile">我的</NavLink>
    </nav>}
  </div>;
}
