import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider.js';
import { App } from './App.js';
import { AppShell, isFocusedGameRoute } from './AppShell.js';

vi.mock('../api/game-socket.js', () => ({
  createGameSocket: () => ({
    connected: false,
    on() { return this; },
    off() { return this; },
    emit() { return this; },
    connect() { return this; },
    disconnect() { return this; }
  })
}));

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
  ['/games/game-1/', true],
  ['/games/game-1/settlement', true],
  ['/games/game-1/settlement/', true],
  ['/games/new', false],
  ['/games/new/', false],
  ['/games/new/settlement', false],
  ['/games/new/settlement/', false],
  ['/games/new/another-segment', false],
  ['/games/manage', false],
  ['/games/manage/', false],
  ['/games/newish/settlement/', true],
  ['/games/game-1/extra', false],
  ['/history/game-1', false],
  ['/profile', false],
  ['/users', false],
])('classifies focused routes including one optional trailing slash: %s', (pathname, focused) => {
  // Break caught: React Router renders a trailing-slash game route while the shell leaves its global navigation visible.
  expect(isFocusedGameRoute(pathname)).toBe(focused);
});

it.each([
  ['/games/game-1/', true, true],
  ['/games/game-1/settlement/', true, false],
  ['/games/new/', false, false],
  ['/games/new/settlement/', false, false],
  ['/history/game-1', false, false],
])('uses focused shell mode only for the active game workspace: %s', async (pathname, focused, liveGame) => {
  // Break caught: a live table and settlement share dock clearance, or a normal route loses navigation.
  renderShell(pathname);
  await screen.findByRole('button', { name: '退出登录' });

  const shell = screen.getByText('路由内容').closest('.app-shell');
  const navigation = screen.queryByRole('navigation', { name: '主导航' });

  expect(shell).toHaveClass('app-shell');
  expect(shell).toHaveClass(liveGame ? 'app-shell--game' : 'app-shell');
  if (!liveGame) expect(shell).not.toHaveClass('app-shell--game');
  if (focused) expect(shell).toHaveClass('app-shell--focus');
  else expect(shell).not.toHaveClass('app-shell--focus');
  if (focused) expect(navigation).not.toBeInTheDocument();
  else expect(navigation).toBeVisible();
  const header = screen.getByRole('banner');
  if (liveGame) expect(header).toHaveClass('app-header--game');
  else expect(header).not.toHaveClass('app-header--game');
});

it('keeps only home and profile in the bottom navigation and treats history as part of home', async () => {
  renderShell('/history/select');
  await screen.findByText('路由内容');

  const navigation = screen.getByRole('navigation', { name: '主导航' });
  expect(within(navigation).getAllByRole('link').map((link) => link.textContent)).toEqual(['首页', '我的']);
  expect(within(navigation).getByRole('link', { name: '首页' })).toHaveClass('active');
  expect(within(navigation).getByRole('link', { name: '首页' })).toHaveAttribute('aria-current', 'page');
  expect(within(navigation).queryByRole('link', { name: '战绩' })).not.toBeInTheDocument();
});

it('routes the profile tool entry to a protected standalone equity calculator', async () => {
  // Break caught: the approved tools link falls through to home or becomes a third bottom-navigation tab.
  window.history.replaceState({}, '', '/tools/equity');
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith('/api/auth/session')) return jsonResponse({
      user: {
        id: 'user-1', username: 'tianyi', nickname: '天一', role: 'USER', mustChangePassword: false,
        avatarKind: 'PRESET', avatarValue: 'preset-13'
      },
      csrfToken
    });
    return jsonResponse({});
  }));

  render(<App />);

  expect(await screen.findByRole('heading', { name: '胜率计算器' })).toBeInTheDocument();
  const navigation = screen.getByRole('navigation', { name: '主导航' });
  expect(within(navigation).getAllByRole('link').map((link) => link.textContent)).toEqual(['首页', '我的']);
  expect(within(navigation).getByRole('link', { name: '我的' })).toHaveClass('active');
  expect(within(navigation).getByRole('link', { name: '我的' })).toHaveAttribute('aria-current', 'page');
});

it('lets a regular user reach the settlement route where the API remains authoritative', async () => {
  // Break caught: a creator's settlement link redirects at the route gate before the server can enforce ownership.
  window.history.replaceState({}, '', '/games/game-1/settlement');
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse({
      user: {
        id: 'user-1', username: 'user', nickname: '玩家', role: 'USER', mustChangePassword: false,
        avatarKind: 'PRESET', avatarValue: 'preset-01'
      },
      csrfToken
    });
    if (url.endsWith('/api/games/game-1/settlement-draft')) return jsonResponse({
      gameId: 'game-1', version: 1, editorUserId: 'user-1', editorNickname: '玩家',
      leaseExpiresAt: '2026-08-27T12:00:00.000+08:00', canEdit: true, canTakeOver: false,
      payload: { cashOutByPlayerId: { 'player-1': '100' }, roomFee: '0', roomPayerIds: [], otherFee: '0', otherFeeNote: '', otherPayerIds: [] },
      totals: { buyIn: '100', cashOut: '100', roomFee: '0', otherFee: '0', rake: '0', final: '0' },
      players: [{ playerId: 'player-1', nickname: '玩家', avatarKind: 'PRESET', avatarValue: 'preset-01', seatNo: 1, buyIn: '100', cashOut: '100', rawProfit: '0', roomFeeShare: '0', otherFeeShare: '0', afterFeeProfit: '0', rakeEligible: false, rakeAmount: '0', finalAmount: '0' }],
      draftVersion: 1, settingsVersion: 1, previewReady: true, validationCode: null, confirmationToken: 'token'
    });
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));

  render(<App />);

  expect(await screen.findByRole('heading', { name: '结算向导' })).toBeInTheDocument();
});

it('uses a compact shell for monthly ranking without the oversized global branding', async () => {
  renderShell('/history/monthly');
  await screen.findByText('路由内容');

  expect(screen.queryByRole('banner')).not.toBeInTheDocument();
  expect(screen.queryByText('德州计分')).not.toBeInTheDocument();
  expect(screen.queryByText(/晚上好/)).not.toBeInTheDocument();
  expect(screen.getByText('路由内容').closest('.app-shell')).toHaveClass('app-shell--compact-detail');
  expect(screen.getByRole('navigation', { name: '主导航' })).toBeVisible();
});

it('enables iPhone cover viewport so CSS safe-area insets are available', () => {
  // Break caught: the browser omits viewport-fit=cover and reports zero safe-area insets on iPhone.
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
  const viewport = html.match(/<meta\s+name=["']viewport["']\s+content=["']([^"']+)["']/i);

  expect(viewport?.[1]).toContain('viewport-fit=cover');
});

it('keeps the live arena within dynamic viewport and both narrow mobile boundaries', () => {
  // Break caught: fixed heights hide observers or the action dock behind iPhone browser and safe-area chrome.
  const css = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8');

  expect(css).toMatch(/\.app-shell--game\s*\{[^}]*100dvh/s);
  expect(css).toMatch(/\.app-shell--game\s*\{[^}]*overflow:\s*hidden/s);
  expect(css).toMatch(/\.battle-panel\s*\{[^}]*overflow:\s*hidden/s);
  expect(css).toMatch(/\.round-table\s*\{[^}]*min-height:\s*0[^}]*flex:\s*1/s);
  expect(css).toContain('safe-area-inset-bottom');
  expect(css).toMatch(/\.game-tabs\s*\{[^}]*repeat\(3,/s);
  expect(css).toContain('@media (max-width: 420px)');
  expect(css).toContain('@media (max-width: 359px)');
});
