import type { AuthSessionResponse, AuthUserContract, ChangePasswordRequest, LoginRequest } from '@poker/contracts';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUserContract | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const authEpoch = useRef(0);
  const isMounted = useRef(false);

  const beginAuthOperation = useCallback(() => {
    const epoch = ++authEpoch.current;
    if (isMounted.current) setIsLoading(true);
    return epoch;
  }, []);

  const isCurrentOperation = useCallback((epoch: number) => (
    isMounted.current && authEpoch.current === epoch
  ), []);

  const completeOperation = useCallback((epoch: number) => {
    if (isCurrentOperation(epoch)) setIsLoading(false);
  }, [isCurrentOperation]);

  const applySession = useCallback((epoch: number, session: AuthSessionResponse): AuthUserContract => {
    if (isCurrentOperation(epoch)) {
      setUser(session.user);
      setCsrfToken(session.csrfToken);
      csrfTokenStore.set(session.csrfToken);
    }
    return session.user;
  }, [isCurrentOperation]);

  const clearSession = useCallback((epoch: number) => {
    if (isCurrentOperation(epoch)) {
      setUser(null);
      setCsrfToken(null);
      csrfTokenStore.clear();
    }
  }, [isCurrentOperation]);

  const refreshSession = useCallback(async (): Promise<AuthUserContract | null> => {
    const epoch = beginAuthOperation();
    try {
      const session = await apiFetch<AuthSessionResponse>('/auth/session');
      return applySession(epoch, session);
    } catch {
      clearSession(epoch);
      return null;
    } finally {
      completeOperation(epoch);
    }
  }, [applySession, beginAuthOperation, clearSession, completeOperation]);

  useEffect(() => {
    isMounted.current = true;
    void refreshSession();
    return () => {
      isMounted.current = false;
      ++authEpoch.current;
    };
  }, [refreshSession]);

  const login = useCallback(async (credentials: LoginRequest): Promise<AuthUserContract> => {
    const epoch = beginAuthOperation();
    try {
      const session = await apiFetch<AuthSessionResponse>('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials)
      });
      return applySession(epoch, session);
    } finally {
      completeOperation(epoch);
    }
  }, [applySession, beginAuthOperation, completeOperation]);

  const logout = useCallback(async (): Promise<void> => {
    const epoch = beginAuthOperation();
    try {
      await apiFetch<{ success: true }>('/auth/logout', { method: 'POST' });
    } finally {
      clearSession(epoch);
      completeOperation(epoch);
    }
  }, [beginAuthOperation, clearSession, completeOperation]);

  const changePassword = useCallback(async (credentials: ChangePasswordRequest): Promise<AuthUserContract> => {
    const epoch = beginAuthOperation();
    try {
      const session = await apiFetch<AuthSessionResponse>('/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials)
      });
      return applySession(epoch, session);
    } finally {
      completeOperation(epoch);
    }
  }, [applySession, beginAuthOperation, completeOperation]);

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
