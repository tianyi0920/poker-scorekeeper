import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider.js';
import { App } from './App.js';
import { AppShell } from './AppShell.js';

const csrfToken = 'a'.repeat(64);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function renderShell(pathname: string) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[pathname]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="*" element={<div>路由内容</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  );
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

it.each([
  ['/games/game-1', true],
  ['/games/game-1/settlement', true],
  ['/games/new', false],
  ['/history/game-1', false],
  ['/profile', false],
  ['/users', false],
])('uses focused shell mode only for the active game workspace: %s', async (pathname, focused) => {
  // Break caught: a live game keeps global navigation, or a create/history/admin route loses it.
  renderShell(pathname);
  await screen.findByRole('button', { name: '退出登录' });

  const shell = screen.getByText('路由内容').closest('.app-shell');
  const navigation = screen.queryByRole('navigation', { name: '主导航' });

  expect(shell).toHaveClass(focused ? 'app-shell--focus' : 'app-shell');
  if (focused) expect(navigation).not.toBeInTheDocument();
  else expect(navigation).toBeVisible();
});

it('enables iPhone cover viewport so CSS safe-area insets are available', () => {
  // Break caught: the browser omits viewport-fit=cover and reports zero safe-area insets on iPhone.
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
  const viewport = html.match(/<meta\s+name=["']viewport["']\s+content=["']([^"']+)["']/i);

  expect(viewport?.[1]).toContain('viewport-fit=cover');
});
