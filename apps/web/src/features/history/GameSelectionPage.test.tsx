import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { GameSelectionPage } from './GameSelectionPage.js';
import { jsonResponse } from '../../test/app-fixtures.js';

function LocationProbe() { return <output>{useLocation().search}</output>; }
afterEach(() => vi.unstubAllGlobals());

it('loads the second server-visible history page and only navigates with selected returned ids', async () => {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/history?limit=50')) return jsonResponse({ items: [{ gameId: 'game-1', name: '第一页', completedAt: '2026-08-18T12:00:00.000+08:00', settledByNickname: '天一', myFinalAmount: '10' }], nextCursor: 'next-1' });
    if (url.includes('cursor=next-1')) return jsonResponse({ items: [{ gameId: 'game-1', name: '第一页', completedAt: '2026-08-18T12:00:00.000+08:00', settledByNickname: '天一', myFinalAmount: '10' }, { gameId: 'game-2', name: '第二页', completedAt: '2026-08-17T12:00:00.000+08:00', settledByNickname: '老王', myFinalAmount: '-10' }], nextCursor: null });
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter initialEntries={['/history/select']}><GameSelectionPage /><LocationProbe /></MemoryRouter>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '加载更多可见对局' }));
  await user.click(await screen.findByLabelText('选择第二页'));
  await user.click(screen.getByRole('button', { name: '汇总已选 1 局' }));
  expect(screen.getByText('?games=game-2')).toBeInTheDocument();
  expect(screen.getAllByText('第一页')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: '加载更多可见对局' })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('cursor=next-1'))).toBe(true);
});

it('shows a recoverable pagination error without inventing another page', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).includes('cursor=next-1') ? jsonResponse({ code: 'TEMPORARY' }, 500) : jsonResponse({ items: [{ gameId: 'game-1', name: '第一页', completedAt: '2026-08-18T12:00:00.000+08:00', settledByNickname: '天一', myFinalAmount: '10' }], nextCursor: 'next-1' })));
  render(<MemoryRouter initialEntries={['/history/select']}><GameSelectionPage /></MemoryRouter>);
  await userEvent.setup().click(await screen.findByRole('button', { name: '加载更多可见对局' }));
  expect(await screen.findByText('更多可选择的历史对局暂时无法加载。')).toBeInTheDocument();
  expect(screen.getByText('第一页')).toBeInTheDocument();
});
