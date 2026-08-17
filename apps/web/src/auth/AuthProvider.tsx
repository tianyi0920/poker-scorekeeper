import type { AuthSessionResponse, AuthUserContract, ChangePasswordRequest, LoginRequest } from '@poker/contracts';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiFetch, csrfTokenStore } from '../api/http-client.js';

interface AuthContextValue {
  user: AuthUserContract | null;
  csrfToken: string | null;
  isLoading: boolean;
  login(credentials: LoginRequest): Promise<AuthUserContract>;
  logout(): Promise<void>;
  refreshSession(): Promise<AuthUserContract | null>;
  changePassword(credentials: ChangePasswordRequest): Promise<AuthUserContract>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function applySession(session: AuthSessionResponse, setUser: (user: AuthUserContract | null) => void, setCsrfToken: (token: string | null) => void): AuthUserContract {
  setUser(session.user);
  setCsrfToken(session.csrfToken);
  csrfTokenStore.set(session.csrfToken);
  return session.user;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUserContract | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const clearSession = useCallback(() => {
    setUser(null);
    setCsrfToken(null);
    csrfTokenStore.clear();
  }, []);

  const refreshSession = useCallback(async (): Promise<AuthUserContract | null> => {
    try {
      const session = await apiFetch<AuthSessionResponse>('/auth/session');
      return applySession(session, setUser, setCsrfToken);
    } catch {
      clearSession();
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [clearSession]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const login = useCallback(async (credentials: LoginRequest): Promise<AuthUserContract> => {
    const session = await apiFetch<AuthSessionResponse>('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials)
    });
    return applySession(session, setUser, setCsrfToken);
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await apiFetch<{ success: true }>('/auth/logout', { method: 'POST' });
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const changePassword = useCallback(async (credentials: ChangePasswordRequest): Promise<AuthUserContract> => {
    const session = await apiFetch<AuthSessionResponse>('/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials)
    });
    return applySession(session, setUser, setCsrfToken);
  }, []);

  const value = useMemo(() => ({
    user, csrfToken, isLoading, login, logout, refreshSession, changePassword
  }), [user, csrfToken, isLoading, login, logout, refreshSession, changePassword]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error('useAuth must be used within AuthProvider');
  return value;
}
