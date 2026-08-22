import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App.js';
import { currentGame, jsonResponse, renderAt, session } from '../../test/app-fixtures.js';

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

it('creates one active game and navigates without a confirmation modal', async () => {
  // Break caught: creating a game either exposes a second action or does not enter the active table immediately.
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('ADMIN'));
    if (url.endsWith('/api/games') && init?.method === 'POST') {
      calls.push('create');
      return jsonResponse(currentGame(1));
    }
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));

  const user = userEvent.setup();
  renderAt('/games/new', <App />);

  expect(await screen.findByLabelText('每手金额')).toHaveValue(300);
  expect(screen.getByRole('checkbox', { name: '启用抽成' })).toBeChecked();
  expect(screen.getByText('名称由服务器自动生成，也可以手动填写')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '创建并开启' }));
  await waitFor(() => expect(window.location.pathname).toBe('/games/game-1'));
  expect(calls).toEqual(['create']);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('disables game creation while offline', async () => {
  // Break caught: an offline user can submit a mutation that cannot be durably recorded.
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(session('ADMIN'))));

  renderAt('/games/new', <App />);

  expect(await screen.findByRole('button', { name: '创建并开启' })).toBeDisabled();
});
