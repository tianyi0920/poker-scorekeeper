import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { ProtectedRoute, PublicOnlyRoute, RoleGate } from '../auth/ProtectedRoute.js';
import { ChangePasswordPage } from '../features/auth/ChangePasswordPage.js';
import { LoginPage } from '../features/auth/LoginPage.js';
import { CreateGamePage } from '../features/games/CreateGamePage.js';
import { HomePage } from '../features/home/HomePage.js';
import { ProfilePage } from '../features/profile/ProfilePage.js';
import { RakeSettingsPage } from '../features/settings/RakeSettingsPage.js';
import { UserFormPage } from '../features/users/UserFormPage.js';
import { UserListPage } from '../features/users/UserListPage.js';
import { AppShell, OfflineBanner } from './AppShell.js';

function HistoryPlaceholder() {
  return <section className="page-stack"><div className="page-title"><span className="section-kicker">HISTORY</span><h2>战绩</h2><p>历史筛选与全员汇总将在历史模块接入后显示。</p></div></section>;
}

function GamePlaceholder() {
  return <section className="page-stack"><div className="page-title"><span className="section-kicker">TABLE</span><h2>对局</h2><p>正在进入牌桌…</p></div></section>;
}

function ProtectedShell() {
  return <ProtectedRoute><AppShell /></ProtectedRoute>;
}

export function AppRouter() {
  return <BrowserRouter><AuthProvider><OfflineBanner /><Routes>
    <Route path="/login" element={<PublicOnlyRoute><LoginPage /></PublicOnlyRoute>} />
    <Route path="/change-password" element={<ProtectedRoute><ChangePasswordPage /></ProtectedRoute>} />
    <Route element={<ProtectedShell />}>
      <Route index element={<HomePage />} />
      <Route path="history" element={<HistoryPlaceholder />} />
      <Route path="profile" element={<ProfilePage />} />
      <Route path="games/new" element={<RoleGate roles={['ADMIN', 'SUPER_ADMIN']}><CreateGamePage /></RoleGate>} />
      <Route path="games/:id" element={<GamePlaceholder />} />
      <Route path="users" element={<RoleGate roles={['ADMIN', 'SUPER_ADMIN']}><UserListPage /></RoleGate>} />
      <Route path="users/new" element={<RoleGate roles={['ADMIN', 'SUPER_ADMIN']}><UserFormPage mode="create" /></RoleGate>} />
      <Route path="users/:id/edit" element={<RoleGate roles={['ADMIN', 'SUPER_ADMIN']}><UserFormPage mode="edit" /></RoleGate>} />
      <Route path="settings/rake" element={<RoleGate roles={['SUPER_ADMIN']}><RakeSettingsPage /></RoleGate>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></AuthProvider></BrowserRouter>;
}

export function ProtectedOutlet() {
  return <ProtectedRoute><Outlet /></ProtectedRoute>;
}
