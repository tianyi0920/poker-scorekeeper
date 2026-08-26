import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App.js';
import { jsonResponse, renderAt, session } from '../../test/app-fixtures.js';
import { monthlyRankingPeriods } from './MonthlyRankingPage.js';

const players = [
  { userId: 'user-2', nickname: '西西', avatarUrl: '/avatars/preset-02.webp', finalAmount: '1500' },
  { userId: 'user-1', nickname: '阿明', avatarUrl: '/avatars/preset-01.webp', finalAmount: '0' },
  { userId: 'user-3', nickname: '老王', avatarUrl: '/avatars/preset-03.webp', finalAmount: '-300' }
].map((player) => ({
  ...player,
  gamesPlayed: 2,
  wins: 1,
  losses: 1,
  rawProfit: player.finalAmount,
  roomFeeShare: '0',
  otherFeeShare: '0',
  afterFeeProfit: player.finalAmount,
  rakeAmount: '0',
  games: []
}));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-08-26T04:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('crosses the year boundary when January shows the previous month', () => {
  expect(monthlyRankingPeriods(new Date('2026-01-15T04:00:00.000Z'))).toEqual([
    { year: 2026, month: 1, tabLabel: '本月 · 1月' },
    { year: 2025, month: 12, tabLabel: '上月 · 12月' }
  ]);
});

it('shows only final-profit ranking for the current and previous Shanghai months', async () => {
  const requestBodies: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session());
    if (url.endsWith('/api/history/aggregate')) {
      requestBodies.push(JSON.parse(String(init?.body)) as unknown);
      return jsonResponse({ gameIds: ['game-1', 'game-2'], gameCount: 2, playerCount: 3, players });
    }
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));

  renderAt('/history/monthly', <App />);

  expect(await screen.findByRole('heading', { name: '月度排名' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '历史战绩' })).toHaveAttribute('href', '/?tab=history');
  expect(screen.getByRole('tab', { name: '本月 · 8月' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText('2026年8月')).toBeInTheDocument();
  expect(await screen.findByText('统计你参与的 2 场已结算牌局')).toBeInTheDocument();
  expect(screen.getByText('+¥1,500')).toBeInTheDocument();
  expect(screen.getByText('¥0')).toBeInTheDocument();
  expect(screen.getByText('−¥300')).toBeInTheDocument();
  expect(screen.queryByText('房费')).not.toBeInTheDocument();
  expect(screen.queryByText('抽成')).not.toBeInTheDocument();
  expect(requestBodies).toEqual([{ filter: { kind: 'MY_MONTH', year: 2026, month: 8 } }]);

  fireEvent.click(screen.getByRole('tab', { name: '上月 · 7月' }));
  await waitFor(() => expect(requestBodies).toEqual([
    { filter: { kind: 'MY_MONTH', year: 2026, month: 8 } },
    { filter: { kind: 'MY_MONTH', year: 2026, month: 7 } }
  ]));
  expect(screen.getByText('2026年7月')).toBeInTheDocument();
});
