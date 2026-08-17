import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App.js';

const csrfToken = 'a'.repeat(64);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith('/api/auth/session')) {
      return jsonResponse({
        user: {
          id: 'user-1',
          username: 'tianyi',
          nickname: '天一',
          role: 'SUPER_ADMIN',
          mustChangePassword: true
        },
        csrfToken
      });
    }
    return jsonResponse({});
  }));
});

afterEach(() => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

it('redirects a forced-change user before rendering home', async () => {
  // Break caught: the mustChangePassword route gate is removed or bypassed.
  render(<App />);

  expect(await screen.findByRole('heading', { name: '修改初始密码' })).toBeInTheDocument();
  expect(screen.queryByLabelText('主页基础框架')).not.toBeInTheDocument();
});

it('announces offline state and disables the logout write action', async () => {
  // Break caught: an unsafe action remains clickable while the client is offline.
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
    user: {
      id: 'user-1', username: 'tianyi', nickname: '天一', role: 'USER', mustChangePassword: false
    },
    csrfToken
  })));

  render(<App />);

  expect(await screen.findByText('当前离线，写入操作已禁用。')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '退出登录' })).toBeDisabled();
});
