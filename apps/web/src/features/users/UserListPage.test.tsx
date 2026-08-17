import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App.js';
import { jsonResponse, renderAt, session } from '../../test/app-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

const ordinaryUser = {
  id: 'user-1', username: 'aming', nickname: '阿明', role: 'USER', rakeEnabled: true,
  avatarKind: 'PRESET', avatarValue: 'preset-01', isActive: true, mustChangePassword: false,
  deletedAt: null, createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z'
} as const;

const administrator = {
  ...ordinaryUser,
  id: 'admin-2', username: 'admin2', nickname: '二号管理员', role: 'ADMIN'
} as const;

it('keeps the restore dialog open so a conflicting nickname can be corrected', async () => {
  // Break caught: restore skipped nickname input and sent users to an edit page they cannot access while deleted.
  const restoreBodies: unknown[] = [];
  let restoreAttempts = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('SUPER_ADMIN'));
    if (url.endsWith('/api/users') && (!init?.method || init.method === 'GET')) {
      return jsonResponse({ users: [{ ...ordinaryUser, deletedAt: '2026-08-17T01:00:00.000Z' }] });
    }
    if (url.endsWith('/api/users/user-1/restore') && init?.method === 'POST') {
      restoreBodies.push(JSON.parse(String(init.body)));
      restoreAttempts += 1;
      if (restoreAttempts === 1) return jsonResponse({ code: 'NICKNAME_TAKEN' }, 409);
      return jsonResponse(ordinaryUser);
    }
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));
  const user = userEvent.setup();
  renderAt('/users', <App />);

  await user.click(await screen.findByRole('button', { name: '恢复' }));
  const dialog = screen.getByRole('dialog', { name: '恢复用户' });
  const nickname = screen.getByLabelText('恢复后的昵称');
  expect(nickname).toHaveValue('阿明');

  await user.clear(nickname);
  await user.type(nickname, '新阿明');
  await user.click(screen.getByRole('button', { name: '确认恢复' }));

  expect(await screen.findByText('昵称已被使用，请换一个')).toBeInTheDocument();
  expect(dialog).toBeInTheDocument();
  expect(nickname).toHaveValue('新阿明');
  expect(restoreBodies).toEqual([{ nickname: '新阿明' }]);

  await user.click(screen.getByRole('button', { name: '确认恢复' }));
  expect(restoreBodies).toEqual([{ nickname: '新阿明' }, { nickname: '新阿明' }]);
  expect(screen.queryByRole('dialog', { name: '恢复用户' })).not.toBeInTheDocument();
});

it('offers avatar reset only for targets allowed by the actor role and keeps failures in the dialog', async () => {
  // Break caught: there was no avatar reset action or failure state in user management.
  let resetCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('ADMIN'));
    if (url.endsWith('/api/users') && (!init?.method || init.method === 'GET')) {
      return jsonResponse({ users: [ordinaryUser, administrator] });
    }
    if (url.endsWith('/api/users/user-1/avatar/reset') && init?.method === 'POST') {
      resetCalls += 1;
      return jsonResponse({ code: 'INTERNAL_ERROR' }, 500);
    }
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));
  const user = userEvent.setup();
  renderAt('/users', <App />);

  const resetButtons = await screen.findAllByRole('button', { name: '重置头像' });
  expect(resetButtons).toHaveLength(1);
  await user.click(resetButtons[0]!);
  expect(screen.getByRole('dialog', { name: '确认重置头像' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '确认重置' }));

  expect(await screen.findByText('服务暂时不可用，请稍后重试')).toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: '确认重置头像' })).toBeInTheDocument();
  expect(resetCalls).toBe(1);
});

it('allows a SUPER_ADMIN to reset avatars for every active role', async () => {
  // Regression caught: the ADMIN-only target filter must not be applied to SUPER_ADMIN.
  const superTarget = { ...ordinaryUser, id: 'super-2', username: 'super2', nickname: '二号超管', role: 'SUPER_ADMIN' } as const;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('SUPER_ADMIN'));
    if (url.endsWith('/api/users') && (!init?.method || init.method === 'GET')) {
      return jsonResponse({ users: [ordinaryUser, administrator, superTarget] });
    }
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));

  renderAt('/users', <App />);

  expect(await screen.findAllByRole('button', { name: '重置头像' })).toHaveLength(3);
});
