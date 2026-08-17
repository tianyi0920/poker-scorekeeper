import type { AuthRole } from '@poker/contracts';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider.js';

export function ProtectedRoute({ children, roles }: { children: ReactNode; roles?: AuthRole[] }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <main className="page-status" aria-live="polite">正在恢复会话…</main>;
  if (user === null) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  if (roles !== undefined && !roles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

export function RoleGate({ children, roles }: { children: ReactNode; roles: AuthRole[] }) {
  return <ProtectedRoute roles={roles}>{children}</ProtectedRoute>;
}
