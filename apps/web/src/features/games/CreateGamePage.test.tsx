import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App.js';
import { currentGame, jsonResponse, renderAt, session } from '../../test/app-fixtures.js';

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

it('uses the server generated name and requires confirmation before immediately starting', async () => {
  // Break caught: immediately-open creates or starts a game without the explicit second confirmation.
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('ADMIN'));
    if (url.endsWith('/api/games') && init?.method === 'POST') {
      calls.push('create');
      return jsonResponse({ ...currentGame(1), name: '8月17日晚场', status: 'DRAFT', startedAt: null });
    }
    if (url.endsWith('/api/games/game-1/start') && init?.method === 'POST') {
      calls.push('start');
      return jsonResponse(currentGame(1));
    }
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));

  const user = userEvent.setup();
  renderAt('/games/new', <App />);

  expect(await screen.findByLabelText('每手金额')).toHaveValue(300);
  expect(screen.getByRole('checkbox', { name: '启用抽成' })).toBeChecked();
  expect(screen.getByText('名称由服务器自动生成，也可以手动填写')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '创建并立即开启' }));
  expect(await screen.findByRole('dialog', { name: '确认开启对局' })).toBeInTheDocument();
  expect(calls).toEqual(['create']);

  await user.click(screen.getByRole('button', { name: '确认开启' }));
  expect(calls).toEqual(['create', 'start']);
});

it('disables game creation while offline', async () => {
  // Break caught: an offline user can submit a mutation that cannot be durably recorded.
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(session('ADMIN'))));

  renderAt('/games/new', <App />);

  expect(await screen.findByRole('button', { name: '创建草稿' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '创建并立即开启' })).toBeDisabled();
});

it('retains a cancelled draft with an explicit entry and retry path', async () => {
  // Break caught: closing the confirmation discarded the only client-side reference to the server draft.
  let createCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('ADMIN'));
    if (url.endsWith('/api/games') && init?.method === 'POST') {
      createCalls += 1;
      return jsonResponse({ ...currentGame(1), name: '保留草稿', status: 'DRAFT', startedAt: null });
    }
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));
  const user = userEvent.setup();
  renderAt('/games/new', <App />);

  await user.click(await screen.findByRole('button', { name: '创建并立即开启' }));
  await user.click(await screen.findByRole('button', { name: '暂不开启' }));

  expect(screen.getByRole('heading', { name: '草稿已保留' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '进入草稿' })).toHaveAttribute('href', '/games/game-1');
  expect(screen.getByRole('button', { name: '重试开启' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '创建并立即开启' })).not.toBeInTheDocument();
  expect(createCalls).toBe(1);
});

it('retries starting the retained draft without posting a duplicate create request', async () => {
  // Break caught: a failed start removed the draft ID, so retry created a second server draft.
  const calls: string[] = [];
  let startAttempts = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('ADMIN'));
    if (url.endsWith('/api/games') && init?.method === 'POST') {
      calls.push('create');
      return jsonResponse({ ...currentGame(1), name: '待重试草稿', status: 'DRAFT', startedAt: null });
    }
    if (url.endsWith('/api/games/game-1/start') && init?.method === 'POST') {
      calls.push('start');
      startAttempts += 1;
      if (startAttempts === 1) return jsonResponse({ code: 'GAME_STATE_CONFLICT' }, 409);
      return jsonResponse(currentGame(1));
    }
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));
  const user = userEvent.setup();
  renderAt('/games/new', <App />);

  await user.click(await screen.findByRole('button', { name: '创建并立即开启' }));
  await user.click(await screen.findByRole('button', { name: '确认开启' }));
  expect(await screen.findByText('对局状态已变化，请刷新后重试')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '草稿已保留' })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '重试开启' }));
  await user.click(await screen.findByRole('button', { name: '确认开启' }));

  expect(calls).toEqual(['create', 'start', 'start']);
});
