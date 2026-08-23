import type { ManagedGameDto } from '@poker/contracts';
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App.js';
import { jsonResponse, renderAt, session } from '../../test/app-fixtures.js';
import { GameManagementPage } from './GameManagementPage.js';

function managedGame(id: string, name: string, status: ManagedGameDto['status']): ManagedGameDto {
  return {
    id,
    name,
    status,
    createdAt: '2026-08-24T10:00:00.000+08:00',
    startedAt: status === 'DRAFT' ? null : '2026-08-24T10:05:00.000+08:00',
    completedAt: status === 'COMPLETED' || status === 'VOIDED' ? '2026-08-24T12:00:00.000+08:00' : null,
    playerCount: status === 'DRAFT' ? 0 : 4
  };
}

const fiveStates = [
  managedGame('draft-1', '草稿局', 'DRAFT'),
  managedGame('active-1', '活动局', 'ACTIVE'),
  managedGame('settling-1', '结算局', 'SETTLING'),
  managedGame('completed-1', '完成局', 'COMPLETED'),
  managedGame('voided-1', '作废局', 'VOIDED')
];

afterEach(() => vi.unstubAllGlobals());

it('loads 50 games and renders all statuses, times, player counts, and only applicable destinations', async () => {
  // Break caught: management hides lifecycle states/data or offers links that cannot represent the target state.
  const fetchMock = vi.fn(async () => jsonResponse({ items: fiveStates, nextCursor: null }));
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter><GameManagementPage /></MemoryRouter>);

  expect(await screen.findByRole('heading', { name: '对局管理' })).toBeInTheDocument();
  await screen.findByRole('article', { name: '草稿局' });
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/games/manage?limit=50',
    expect.objectContaining({ credentials: 'same-origin' })
  );
  for (const label of ['草稿', '进行中', '结算中', '已完成', '已作废']) {
    expect(screen.getByText(label)).toBeInTheDocument();
  }

  const active = screen.getByRole('article', { name: '活动局' });
  expect(within(active).getByText('创建时间')).toBeInTheDocument();
  expect(within(active).getByText('开始时间')).toBeInTheDocument();
  expect(within(active).getByText('玩家人数')).toBeInTheDocument();
  expect(within(active).getByText('4 人')).toBeInTheDocument();
  expect(within(active).getByRole('link', { name: '进入牌桌' })).toHaveAttribute('href', '/games/active-1');
  expect(within(screen.getByRole('article', { name: '结算局' })).getByRole('link', { name: '进入结算' })).toHaveAttribute('href', '/games/settling-1/settlement');
  expect(within(screen.getByRole('article', { name: '完成局' })).getByRole('link', { name: '查看历史' })).toHaveAttribute('href', '/history/completed-1');
  expect(within(screen.getByRole('article', { name: '完成局' })).getByText('完成时间')).toBeInTheDocument();
  expect(within(screen.getByRole('article', { name: '草稿局' })).queryByRole('link')).not.toBeInTheDocument();
  expect(within(screen.getByRole('article', { name: '作废局' })).queryByRole('link')).not.toBeInTheDocument();
});

it('appends only after loading more, encodes the cursor, and deduplicates by game ID', async () => {
  // Break caught: pagination prefetches/overwrites rows or repeats a boundary item returned by the server.
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({
      items: [managedGame('game-1', '第一页一号', 'ACTIVE'), managedGame('game-2', '第一页二号', 'DRAFT')],
      nextCursor: 'cursor/value'
    }))
    .mockResolvedValueOnce(jsonResponse({
      items: [managedGame('game-2', '重复二号', 'DRAFT'), managedGame('game-3', '第二页三号', 'COMPLETED')],
      nextCursor: null
    }));
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  render(<MemoryRouter><GameManagementPage /></MemoryRouter>);

  await screen.findByRole('article', { name: '第一页一号' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('第二页三号')).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '加载更多' }));

  expect(await screen.findByRole('article', { name: '第二页三号' })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    '/api/games/manage?limit=50&cursor=cursor%2Fvalue',
    expect.objectContaining({ credentials: 'same-origin' })
  );
  expect(screen.getAllByRole('article')).toHaveLength(3);
  expect(screen.getByText('第一页二号')).toBeInTheDocument();
  expect(screen.queryByText('重复二号')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument();
});

it('shows a clear initial error and retries only after the user asks', async () => {
  // Break caught: a failed initial page leaves a blank screen or silently loops requests.
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ code: 'DATABASE_UNAVAILABLE' }, 503))
    .mockResolvedValueOnce(jsonResponse({ items: [managedGame('game-1', '重试成功局', 'ACTIVE')], nextCursor: null }));
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  render(<MemoryRouter><GameManagementPage /></MemoryRouter>);

  expect(await screen.findByRole('alert')).toHaveTextContent('数据库暂时不可用，请稍后重试');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: '重试加载' }));

  expect(await screen.findByRole('article', { name: '重试成功局' })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('opens one dialog, sends one DELETE, removes only that row, and does not refetch', async () => {
  // Break caught: deletion stacks confirmations, removes the wrong row, or reloads the server collection after success.
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/games/manage?limit=50')) {
      return jsonResponse({ items: [managedGame('game-1', '测试局', 'ACTIVE'), managedGame('game-2', '保留局', 'DRAFT')], nextCursor: null });
    }
    if (url.endsWith('/api/games/game-1') && init?.method === 'DELETE') {
      return jsonResponse({ deletedGameId: 'game-1' });
    }
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  render(<MemoryRouter><GameManagementPage /></MemoryRouter>);
  await screen.findByRole('article', { name: '测试局' });

  await user.click(screen.getByRole('button', { name: '永久删除 测试局' }));
  expect(screen.getAllByRole('dialog', { name: '永久删除对局' })).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: '确认永久删除' }));

  expect(await screen.findByText('已永久删除“测试局”')).toBeInTheDocument();
  expect(screen.queryByRole('article', { name: '测试局' })).not.toBeInTheDocument();
  expect(screen.getByRole('article', { name: '保留局' })).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/games/manage'))).toHaveLength(1);
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
});

it.each(['ADMIN', 'USER'] as const)('rejects %s at the real management route', async (role) => {
  // Break caught: hiding the profile entry is mistaken for route authorization.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session(role));
    if (url.endsWith('/api/games/current')) return jsonResponse({ games: [] });
    if (url.includes('/api/history')) return jsonResponse({ items: [], nextCursor: null });
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));
  renderAt('/games/manage', <App />);

  expect(await screen.findByRole('heading', { name: '当前对局' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '对局管理' })).not.toBeInTheDocument();
});

it('allows SUPER_ADMIN through the real route and resets page state after remount', async () => {
  // Break caught: route authorization is absent or stale list state survives a route remount.
  let managementLoads = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('SUPER_ADMIN'));
    if (url.endsWith('/api/games/manage?limit=50')) {
      managementLoads += 1;
      return jsonResponse({
        items: [managedGame(`game-${managementLoads}`, managementLoads === 1 ? '首次挂载局' : '重新挂载局', 'ACTIVE')],
        nextCursor: null
      });
    }
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));
  const user = userEvent.setup();
  renderAt('/games/manage', <App />);

  expect(await screen.findByRole('article', { name: '首次挂载局' })).toBeInTheDocument();
  await user.click(screen.getByRole('link', { name: '我的' }));
  await user.click(await screen.findByRole('link', { name: /对局管理/ }));

  expect(await screen.findByRole('article', { name: '重新挂载局' })).toBeInTheDocument();
  expect(screen.queryByRole('article', { name: '首次挂载局' })).not.toBeInTheDocument();
  expect(managementLoads).toBe(2);
});
