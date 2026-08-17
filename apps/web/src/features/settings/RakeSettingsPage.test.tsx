import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App.js';
import { jsonResponse, renderAt, session } from '../../test/app-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

it('reloads the latest settings after 409 and requires an explicit second submission', async () => {
  // Break caught: a stale settings write silently overwrites another administrator's newer version.
  let gets = 0;
  let patches = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('SUPER_ADMIN'));
    if (url.endsWith('/api/settings/rake') && (!init?.method || init.method === 'GET')) {
      gets += 1;
      return jsonResponse(gets === 1
        ? { threshold: '1000', bps: 1000, version: 2 }
        : { threshold: '1500', bps: 800, version: 3 });
    }
    if (url.endsWith('/api/settings/rake') && init?.method === 'PATCH') {
      patches += 1;
      return patches === 1
        ? jsonResponse({ code: 'SETTINGS_VERSION_CONFLICT' }, 409)
        : jsonResponse({ threshold: '1500', bps: 800, version: 4 });
    }
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));

  const user = userEvent.setup();
  renderAt('/settings/rake', <App />);
  const threshold = await screen.findByLabelText('抽成门槛（元）');
  await user.clear(threshold);
  await user.type(threshold, '1200');
  await user.click(screen.getByRole('button', { name: '保存抽成规则' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('规则已被其他管理员更新');
  expect(threshold).toHaveValue(1500);
  expect(screen.getByLabelText('抽成比例（%）')).toHaveValue(8);
  expect(patches).toBe(1);

  await user.click(screen.getByRole('button', { name: '再次确认保存' }));
  expect(patches).toBe(2);
  expect(await screen.findByText('抽成规则已保存')).toBeInTheDocument();
});

it('rejects a regular administrator who navigates directly to rake settings', async () => {
  // Break caught: the settings page relies on a hidden link instead of a SUPER_ADMIN route gate.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('ADMIN'));
    if (url.endsWith('/api/games/current')) return jsonResponse({ games: [] });
    if (url.endsWith('/api/history?limit=10')) return jsonResponse({ games: [], nextCursor: null });
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));
  renderAt('/settings/rake', <App />);

  expect(await screen.findByRole('heading', { name: '当前对局' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '抽成设置' })).not.toBeInTheDocument();
});
