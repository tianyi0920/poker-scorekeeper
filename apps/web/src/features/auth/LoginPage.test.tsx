import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App.js';

const csrfToken = 'a'.repeat(64);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function renderAppAt(path: string): void {
  window.history.replaceState({}, '', path);
  render(<App />);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) {
      return jsonResponse({ code: 'UNAUTHENTICATED', message: '未登录' }, 401);
    }
    if (url.endsWith('/api/auth/login')) {
      return jsonResponse({ code: 'INVALID_CREDENTIALS', message: 'invalid credentials' }, 401);
    }
    return jsonResponse({});
  }));
});

afterEach(() => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

it('shows the server login error without clearing the username', async () => {
  // Break caught: mapping INVALID_CREDENTIALS to the login feedback is removed.
  const user = userEvent.setup();
  renderAppAt('/login');

  await user.type(screen.getByLabelText('用户名'), 'tianyi');
  await user.type(screen.getByLabelText('密码'), 'wrong-pass');
  await user.click(screen.getByRole('button', { name: '登录' }));

  expect(await screen.findByText('用户名或密码错误')).toBeInTheDocument();
  expect(screen.getByLabelText('用户名')).toHaveValue('tianyi');
});

it('shows the global offline banner on the sign-in route', async () => {
  // Break caught: the offline notice is restricted to authenticated app pages.
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  renderAppAt('/login');

  expect(await screen.findByText('当前离线，写入操作已禁用。')).toBeInTheDocument();
});

it('redirects an authenticated forced-change user away from login', async () => {
  // Break caught: a forced-change account can bypass its required-password route via /login.
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
    user: { id: 'user-1', username: 'tianyi', nickname: '天一', role: 'USER', mustChangePassword: true },
    csrfToken
  })));
  renderAppAt('/login');

  expect(await screen.findByRole('heading', { name: '修改初始密码' })).toBeInTheDocument();
  expect(screen.queryByLabelText('用户名')).not.toBeInTheDocument();
});

it('redirects an authenticated regular user away from login', async () => {
  // Break caught: a normal authenticated account can remain on the sign-in route.
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
    user: { id: 'user-1', username: 'tianyi', nickname: '天一', role: 'USER', mustChangePassword: false },
    csrfToken
  })));
  renderAppAt('/login');

  expect(await screen.findByLabelText('主页基础框架')).toBeInTheDocument();
  expect(screen.queryByLabelText('用户名')).not.toBeInTheDocument();
});

void csrfToken;
