import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AllPlayerSummaryPage } from './AllPlayerSummaryPage.js';
import { jsonResponse } from '../../test/app-fixtures.js';

const aggregation = {
  gameIds: ['game-2', 'game-1'], gameCount: 2, playerCount: 1,
  players: [{ userId: 'p-1', nickname: '超长中文昵称十二人之一', avatarUrl: 'avatar', gamesPlayed: 2, wins: 1, losses: 1, rawProfit: '9007199254740993000', roomFeeShare: '380', otherFeeShare: '20', afterFeeProfit: '9007199254740992600', rakeAmount: '100', finalAmount: '9007199254740992500', games: [{ gameId: 'game-2', gameName: '昨晚深夜局', completedAt: '2026-08-17T22:00:00.000+08:00', finalAmount: '9007199254740992500' }] }]
};

afterEach(() => vi.unstubAllGlobals());

it('uses server player order and expands exact per-game rows without Number recalculation', async () => {
  // Break caught: UI re-sorts or converts MoneyJson through Number, changing audit values.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).endsWith('/api/history/aggregate') ? jsonResponse(aggregation) : jsonResponse({ code: 'NOT_FOUND' }, 404)));
  render(<MemoryRouter initialEntries={['/history/summary?filter=RECENT_10']}><AllPlayerSummaryPage /></MemoryRouter>);
  expect(await screen.findByText('超长中文昵称十二人之一')).toBeInTheDocument();
  expect(screen.getAllByText('9,007,199,254,740,992,500')).toHaveLength(2);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '展开超长中文昵称十二人之一的逐局明细' }));
  expect(screen.getByText('昨晚深夜局')).toBeInTheDocument();
});

it('sends quick and custom selections without inventing games outside the server-visible list', async () => {
  // Break caught: custom date UI adds client-only games or sends a Number-derived amount.
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    void init;
    return String(input).endsWith('/api/history/aggregate') ? jsonResponse(aggregation) : jsonResponse({ code: 'NOT_FOUND' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter initialEntries={['/history/summary?start=2026-08-01&end=2026-08-18']}><AllPlayerSummaryPage /></MemoryRouter>);
  await screen.findByText('超长中文昵称十二人之一');
  const request = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/history/aggregate'))!;
  expect(JSON.parse((request[1] as RequestInit).body as string)).toEqual({ filter: { kind: 'CUSTOM_DATE_RANGE', startAt: '2026-08-01T00:00:00.000+08:00', endAt: '2026-08-18T23:59:59.999+08:00' } });
});
