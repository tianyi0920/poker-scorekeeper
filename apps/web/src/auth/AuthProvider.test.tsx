import type { AuthSessionResponse } from '@poker/contracts';
import { act, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { csrfTokenStore } from '../api/http-client.js';
import { AuthProvider, useAuth } from './AuthProvider.js';

const csrfToken = 'a'.repeat(64);

function session(username: string): AuthSessionResponse {
  return {
    user: {
      id: username,
      username,
      nickname: username,
      role: 'USER',
      mustChangePassword: false,
      avatarKind: 'PRESET',
      avatarValue: 'preset-01'
    },
    csrfToken
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function AuthProbe() {
  const { user, isLoading, login, logout } = useAuth();
  return <>
    <output aria-label="session-user">{user?.username ?? 'anonymous'}</output>
    <output aria-label="session-loading">{String(isLoading)}</output>
    <button type="button" onClick={() => void login({ username: 'new-user', password: 'secret' })}>登录</button>
    <button type="button" onClick={() => void logout()}>退出</button>
  </>;
}

afterEach(() => {
  csrfTokenStore.clear();
  vi.unstubAllGlobals();
});

it('keeps a completed login when its older session refresh later rejects', async () => {
  // Break caught: a stale initial refresh clears a newer authenticated session.
  const initialSession = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return initialSession.promise;
    if (url.endsWith('/api/auth/login')) return jsonResponse(session('new-user'));
    return jsonResponse({});
  }));
  const user = userEvent.setup();
  render(<AuthProvider><AuthProbe /></AuthProvider>);

  await user.click(screen.getByRole('button', { name: '登录' }));
  await waitFor(() => expect(screen.getByLabelText('session-user')).toHaveTextContent('new-user'));
  expect(screen.getByLabelText('session-loading')).toHaveTextContent('false');

  await act(async () => { initialSession.resolve(jsonResponse({ code: 'UNAUTHENTICATED', message: 'old' }, 401)); });
  await waitFor(() => expect(screen.getByLabelText('session-user')).toHaveTextContent('new-user'));
});

it('does not restore a stale successful refresh after logout', async () => {
  // Break caught: an old session response revives a user that has logged out.
  const initialSession = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return initialSession.promise;
    if (url.endsWith('/api/auth/logout')) return jsonResponse({ success: true });
    return jsonResponse({});
  }));
  const user = userEvent.setup();
  render(<AuthProvider><AuthProbe /></AuthProvider>);

  await user.click(screen.getByRole('button', { name: '退出' }));
  await waitFor(() => expect(screen.getByLabelText('session-loading')).toHaveTextContent('false'));
  initialSession.resolve(jsonResponse(session('old-user')));

  await waitFor(() => expect(screen.getByLabelText('session-user')).toHaveTextContent('anonymous'));
});
