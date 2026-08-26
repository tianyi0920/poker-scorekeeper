import { Link, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.js';
import { Button } from '../components/Button.js';
import { useOnlineStatus } from '../hooks/useOnlineStatus.js';

export function OfflineBanner() {
  const online = useOnlineStatus();
  return !online ? <div className="offline-banner" role="status">当前离线，写入操作已禁用。</div> : null;
}

function isReservedGameRoute(pathname: string) {
  return /^\/games\/(?:new|manage)(?:\/|$)/.test(pathname);
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
  const compactDetail = /^\/history\/monthly\/?$/.test(pathname);
  const historyRoute = /^\/history(?:\/|$)/.test(pathname);
  const profileRoute = pathname === '/profile' || /^\/tools(?:\/|$)/.test(pathname);
  const shellClassName = ['app-shell', focused && 'app-shell--focus', liveGame && 'app-shell--game', compactDetail && 'app-shell--compact-detail'].filter(Boolean).join(' ');
  return <div className={shellClassName}>
    {!compactDetail && <header className={liveGame ? 'app-header app-header--game' : 'app-header'}><div><span className="eyebrow">朋友牌局</span><h1>德州计分</h1></div><Button variant="ghost" unsafe aria-label="退出登录" onClick={() => void logout()}>退出</Button></header>}
    <main className="app-content">{!compactDetail && <p className={liveGame ? 'welcome welcome--game' : 'welcome'}>晚上好，{user?.nickname}</p>}<Outlet /></main>
    {!focused && <nav className="bottom-nav" aria-label="主导航">
      <Link to="/" className={pathname === '/' || historyRoute ? 'active' : undefined} aria-current={pathname === '/' || historyRoute ? 'page' : undefined}>首页</Link>
      <Link to="/profile" className={profileRoute ? 'active' : undefined} aria-current={profileRoute ? 'page' : undefined}>我的</Link>
    </nav>}
  </div>;
}
