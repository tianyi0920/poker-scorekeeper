import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../../auth/AuthProvider.js';
import { jsonResponse, session } from '../../test/app-fixtures.js';
import { HistoryPage } from './HistoryPage.js';

const item = { gameId: 'game-1', name: '网络牌局', completedAt: '2026-08-18T12:00:00.000+08:00', settledByNickname: '天一', myFinalAmount: '100' };
const listCacheKey = 'poker-scorekeeper:history-cache:v2:user-1:list';

function renderHistory(response: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => (
    String(input).endsWith('/api/auth/session') ? jsonResponse(session()) : jsonResponse(response)
  )));
  return render(<AuthProvider><MemoryRouter><HistoryPage /></MemoryRouter></AuthProvider>);
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

it.each([
  ['invalid money', { items: [{ ...item, final: 'not-money' }], nextCursor: null }],
  ['duplicate game ids', { items: [item, { ...item, name: '重复牌局' }], nextCursor: null }],
  ['an oversized list', { items: Array.from({ length: 101 }, (_, index) => ({ ...item, gameId: `game-${index + 1}`, name: `牌局 ${index + 1}` })), nextCursor: null }]
])('fails closed for live history with %s', async (_case, response) => {
  renderHistory(response);
  expect(await screen.findByText('历史战绩暂时无法加载，请稍后重试。')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重试加载' })).toBeInTheDocument();
  expect(screen.queryByText('网络牌局')).not.toBeInTheDocument();
  expect(localStorage.getItem(listCacheKey)).toBeNull();
});

it('renders a valid live history response and persists only the parsed value', async () => {
  renderHistory({ items: [item, { ...item, gameId: 'game-2', name: '旁观牌局', myFinalAmount: null }], nextCursor: null });
  expect(await screen.findByText('网络牌局')).toBeInTheDocument();
  expect(screen.getByText('+¥100')).toBeInTheDocument();
  expect(screen.getByText('查看明细')).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem(listCacheKey) ?? 'null')?.value).toEqual({ items: [item, { ...item, gameId: 'game-2', name: '旁观牌局', myFinalAmount: null }], nextCursor: null });
});
