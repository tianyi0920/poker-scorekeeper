import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
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

it('prefills an editable agreed temporary password when creating a user', async () => {
  // Break caught: creating a user no longer starts with the agreed password or locks the operator out of changing it.
  mockSession('ADMIN');
  const user = userEvent.setup();
  renderAt('/users/new', <App />);

  const password = await screen.findByLabelText('初始密码');
  expect(password).toHaveValue('12345678');
  await user.clear(password);
  await user.type(password, 'changed-password');
  expect(password).toHaveValue('changed-password');
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

it('omits role and activation fields when an ADMIN updates a normal user', async () => {
  // Break caught: ADMIN sends forbidden role/isActive fields even when their values are unchanged.
  let patchBody: unknown = null;
  const target = {
    id: 'user-1', username: 'aming', nickname: '阿明', role: 'USER', rakeEnabled: true,
    avatarKind: 'PRESET', avatarValue: 'preset-01', isActive: true, mustChangePassword: false,
    deletedAt: null, createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z'
  };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('ADMIN'));
    if (url.endsWith('/api/users') && (!init?.method || init.method === 'GET')) return jsonResponse({ users: [target] });
    if (url.endsWith('/api/users/user-1') && init?.method === 'PATCH') {
      patchBody = JSON.parse(String(init.body));
      return jsonResponse({ ...target, nickname: '新昵称' });
    }
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));
  const user = userEvent.setup();
  renderAt('/users/user-1/edit', <App />);

  const nickname = await screen.findByLabelText('昵称');
  expect(screen.queryByLabelText('角色')).not.toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: /启用账号/ })).not.toBeInTheDocument();
  await user.clear(nickname);
  await user.type(nickname, '新昵称');
  await user.click(screen.getByRole('button', { name: '保存修改' }));

  expect(patchBody).toEqual({ nickname: '新昵称', rakeEnabled: true });
});

it('includes role and activation fields when a SUPER_ADMIN updates a user', async () => {
  // Regression caught: narrowing ADMIN bodies must not strip fields from authorized SUPER_ADMIN updates.
  let patchBody: unknown = null;
  const target = {
    id: 'admin-2', username: 'admin2', nickname: '二号管理员', role: 'ADMIN', rakeEnabled: true,
    avatarKind: 'PRESET', avatarValue: 'preset-01', isActive: true, mustChangePassword: false,
    deletedAt: null, createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z'
  };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('SUPER_ADMIN'));
    if (url.endsWith('/api/users') && (!init?.method || init.method === 'GET')) return jsonResponse({ users: [target] });
    if (url.endsWith('/api/users/admin-2') && init?.method === 'PATCH') {
      patchBody = JSON.parse(String(init.body));
      return jsonResponse({ ...target, role: 'USER', isActive: false });
    }
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));
  const user = userEvent.setup();
  renderAt('/users/admin-2/edit', <App />);

  await user.selectOptions(await screen.findByLabelText('角色'), 'USER');
  await user.click(screen.getByRole('checkbox', { name: /启用账号/ }));
  await user.click(screen.getByRole('button', { name: '保存修改' }));

  expect(patchBody).toEqual({ nickname: '二号管理员', role: 'USER', rakeEnabled: true, isActive: false });
});
