import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.js';
import { Button } from '../components/Button.js';

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

export function OfflineBanner() {
  const online = useOnlineStatus();
  return !online ? <div className="offline-banner" role="status">当前离线，写入操作已禁用。</div> : null;
}

export function AppShell() {
  const { user, logout } = useAuth();
  return <div className="app-shell">
    <header className="app-header"><h1>德州计分</h1><Button variant="ghost" unsafe aria-label="退出登录" onClick={() => void logout()}>退出</Button></header>
    <main><p>欢迎回来，{user?.nickname}。</p><Outlet /></main>
  </div>;
}
