import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { ProtectedRoute, PublicOnlyRoute } from '../auth/ProtectedRoute.js';
import { ChangePasswordPage } from '../features/auth/ChangePasswordPage.js';
import { LoginPage } from '../features/auth/LoginPage.js';
import { AppShell, OfflineBanner } from './AppShell.js';

function HomePlaceholder() {
  return <section aria-label="主页基础框架" />;
}

function ProtectedShell() {
  return <ProtectedRoute><AppShell /></ProtectedRoute>;
}

export function AppRouter() {
  return <BrowserRouter><AuthProvider><OfflineBanner /><Routes>
    <Route path="/login" element={<PublicOnlyRoute><LoginPage /></PublicOnlyRoute>} />
    <Route path="/change-password" element={<ProtectedRoute><ChangePasswordPage /></ProtectedRoute>} />
    <Route element={<ProtectedShell />}>
      <Route index element={<HomePlaceholder />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></AuthProvider></BrowserRouter>;
}

export function ProtectedOutlet() {
  return <ProtectedRoute><Outlet /></ProtectedRoute>;
}
