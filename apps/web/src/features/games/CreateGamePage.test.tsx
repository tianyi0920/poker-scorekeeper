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
