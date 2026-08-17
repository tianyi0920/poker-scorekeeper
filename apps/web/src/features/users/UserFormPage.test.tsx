import { screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App.js';
import { jsonResponse, renderAt, session } from '../../test/app-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

function mockSession(role: 'SUPER_ADMIN' | 'ADMIN' | 'USER') {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session(role));
    if (url.endsWith('/api/games/current')) return jsonResponse({ games: [] });
    if (url.endsWith('/api/history?limit=10')) return jsonResponse({ games: [], nextCursor: null });
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));
}

it('constructs the administrator role choices with USER only', async () => {
  // Break caught: an ADMIN is offered elevated roles that the permission matrix forbids.
  mockSession('ADMIN');
  renderAt('/users/new', <App />);

  const role = await screen.findByLabelText('角色');
  expect(role).toHaveTextContent('普通用户');
  expect(role).not.toHaveTextContent('管理员');
  expect(role).not.toHaveTextContent('超级管理员');
});

it('constructs all three role choices for a super administrator', async () => {
  // Break caught: a SUPER_ADMIN cannot create another privileged administrator.
  mockSession('SUPER_ADMIN');
  renderAt('/users/new', <App />);

  const role = await screen.findByLabelText('角色');
  expect(role).toHaveTextContent('普通用户');
  expect(role).toHaveTextContent('管理员');
  expect(role).toHaveTextContent('超级管理员');
});

it('rejects a normal user who navigates directly to an administration URL', async () => {
  // Break caught: hiding navigation is the only permission control and direct URLs still render admin forms.
  mockSession('USER');
  renderAt('/users/new', <App />);

  expect(await screen.findByRole('heading', { name: '当前对局' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '创建用户' })).not.toBeInTheDocument();
});

it('does not expose user or rake management links in a normal profile', async () => {
  // Break caught: normal-user navigation exposes privileged administration destinations.
  mockSession('USER');
  renderAt('/profile', <App />);

  expect(await screen.findByRole('heading', { name: '我的' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '用户管理' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '抽成设置' })).not.toBeInTheDocument();
});
