import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AllPlayerSummaryPage } from './AllPlayerSummaryPage.js';
import { jsonResponse } from '../../test/app-fixtures.js';

const aggregation = {
  gameIds: ['game-2', 'game-1'], gameCount: 2, playerCount: 1,
  players: [{ userId: 'p-1', nickname: '超长中文昵称十二人之一', avatarUrl: '/avatars/uploads/latest-avatar.webp', gamesPlayed: 2, wins: 1, losses: 1, rawProfit: '9007199254740993000', roomFeeShare: '380', otherFeeShare: '20', afterFeeProfit: '9007199254740992600', rakeAmount: '100', finalAmount: '9007199254740992500', games: [{ gameId: 'game-2', gameName: '昨晚深夜局', completedAt: '2026-08-17T22:00:00.000+08:00', finalAmount: '9007199254740992500' }] }]
};
const aggregatePlayer = aggregation.players[0]!;
const aggregateGame = aggregatePlayer.games[0]!;

afterEach(() => vi.unstubAllGlobals());

it('shows the latest avatar and transfer-first summary while keeping exact per-game rows collapsed', async () => {
  // Break caught: the summary regresses to six equal metrics, a broken avatar, or eager detail rows.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).endsWith('/api/history/aggregate') ? jsonResponse(aggregation) : jsonResponse({ code: 'NOT_FOUND' }, 404)));
  render(<MemoryRouter initialEntries={['/history/summary?filter=RECENT_10']}><AllPlayerSummaryPage /></MemoryRouter>);
  const nickname = await screen.findByText('超长中文昵称十二人之一');
  const card = nickname.closest<HTMLElement>('.aggregate-card')!;
  const avatar = within(card).getByRole('img', { name: '超长中文昵称十二人之一的当前头像' });
  expect(avatar).toHaveAttribute('src', '/avatars/uploads/latest-avatar.webp');
  expect(within(card).getByText('实际盈利合计')).toBeInTheDocument();
  expect(within(card).getByText('+¥9,007,199,254,740,992,500')).toBeInTheDocument();
  expect(within(card).getByText('银行付款合计')).toBeInTheDocument();
  expect(within(card).getByText('¥9,007,199,254,740,992,600')).toBeInTheDocument();
  expect(within(card).getByText('另付经费合计')).toBeInTheDocument();
  expect(within(card).getByText('¥100')).toBeInTheDocument();
  expect(within(card).getByText('费用已计入：房费 ¥380 · 其他费用 ¥20')).toBeInTheDocument();
  expect(within(card).queryByText('累计牌局盈亏')).not.toBeInTheDocument();
  expect(screen.queryByText('昨晚深夜局')).not.toBeInTheDocument();
  fireEvent.error(avatar);
  await waitFor(() => expect(within(card).getByRole('img', { name: '超长中文昵称十二人之一的当前头像' })).toHaveTextContent('超'));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '展开超长中文昵称十二人之一的逐局明细' }));
  expect(screen.getByText('昨晚深夜局')).toBeInTheDocument();
  expect(screen.getAllByText('+¥9,007,199,254,740,992,500')).toHaveLength(2);
});

it('uses direct transfer wording for losing and neutral aggregate players', async () => {
  // Break caught: losing players see negative payable amounts or an irrelevant expense transfer.
  const losing = {
    ...aggregatePlayer,
    userId: 'p-2', nickname: '西西', avatarUrl: '/avatars/preset-18.webp', gamesPlayed: 1,
    wins: 0, losses: 1, rawProfit: '-1700', roomFeeShare: '0', otherFeeShare: '0',
    afterFeeProfit: '-1700', rakeAmount: '0', finalAmount: '-1700', games: []
  };
  const neutral = {
    ...aggregatePlayer,
    userId: 'p-3', nickname: '小陈', avatarUrl: '/avatars/preset-19.webp', gamesPlayed: 1,
    wins: 0, losses: 0, rawProfit: '0', roomFeeShare: '0', otherFeeShare: '0',
    afterFeeProfit: '0', rakeAmount: '0', finalAmount: '0', games: []
  };
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ...aggregation, playerCount: 3, players: [aggregatePlayer, losing, neutral] })));
  render(<MemoryRouter initialEntries={['/history/summary?filter=RECENT_10']}><AllPlayerSummaryPage /></MemoryRouter>);

  const losingCard = (await screen.findByText('西西')).closest<HTMLElement>('.aggregate-card')!;
  expect(within(losingCard).getByText('实际亏损合计')).toBeInTheDocument();
  expect(within(losingCard).getByText('−¥1,700')).toBeInTheDocument();
  expect(within(losingCard).getByText('转给银行合计')).toBeInTheDocument();
  expect(within(losingCard).getByText('¥1,700')).toBeInTheDocument();
  expect(within(losingCard).getByText('理论转给银行 = 实际亏损合计 · 无需另付经费')).toBeInTheDocument();
  expect(within(losingCard).queryByText('另付经费合计')).not.toBeInTheDocument();

  const neutralCard = screen.getByText('小陈').closest<HTMLElement>('.aggregate-card')!;
  expect(within(neutralCard).getByText('实际金额合计')).toBeInTheDocument();
  expect(within(neutralCard).getByText('本次无需转账')).toBeInTheDocument();
});

it('keeps bank and expense transfers separate when mixed games net to a loss or zero', async () => {
  // Break caught: aggregate final sign hides rake from a winning game or assigns it to the bank.
  const mixedLoser = {
    ...aggregatePlayer,
    userId: 'p-4', nickname: '混合亏损', avatarUrl: '/avatars/preset-20.webp', gamesPlayed: 2,
    wins: 1, losses: 1, rawProfit: '-1200', roomFeeShare: '300', otherFeeShare: '0',
    afterFeeProfit: '-1500', rakeAmount: '200', finalAmount: '-1700', games: []
  };
  const mixedNeutral = {
    ...aggregatePlayer,
    userId: 'p-5', nickname: '混合持平', avatarUrl: '/avatars/preset-21.webp', gamesPlayed: 2,
    wins: 1, losses: 1, rawProfit: '300', roomFeeShare: '100', otherFeeShare: '0',
    afterFeeProfit: '200', rakeAmount: '200', finalAmount: '0', games: []
  };
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ...aggregation, playerCount: 2, players: [mixedNeutral, mixedLoser] })));
  render(<MemoryRouter initialEntries={['/history/summary?filter=RECENT_10']}><AllPlayerSummaryPage /></MemoryRouter>);

  const losingCard = (await screen.findByText('混合亏损')).closest<HTMLElement>('.aggregate-card')!;
  expect(within(losingCard).getByText('实际亏损合计')).toBeInTheDocument();
  expect(within(losingCard).getByText('转给银行合计')).toBeInTheDocument();
  expect(within(losingCard).getByText('¥1,500')).toBeInTheDocument();
  expect(within(losingCard).getByText('另付经费合计')).toBeInTheDocument();
  expect(within(losingCard).getByText('¥200')).toBeInTheDocument();

  const neutralCard = screen.getByText('混合持平').closest<HTMLElement>('.aggregate-card')!;
  expect(within(neutralCard).getByText('实际金额合计')).toBeInTheDocument();
  expect(within(neutralCard).getByText('银行付款合计')).toBeInTheDocument();
  expect(within(neutralCard).getAllByText('¥200')).toHaveLength(2);
  expect(within(neutralCard).queryByText('本次无需转账')).not.toBeInTheDocument();
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

it.each([
  ['invalid money', { ...aggregation, players: [{ ...aggregatePlayer, finalAmount: 'not-money' }] }],
  ['duplicate users', { ...aggregation, playerCount: 2, players: [aggregatePlayer, { ...aggregatePlayer, nickname: '重复用户' }] }],
  ['duplicate per-player games', { ...aggregation, players: [{ ...aggregatePlayer, gamesPlayed: 2, games: [aggregateGame, { ...aggregateGame, gameName: '重复牌局' }] }] }]
])('fails closed for live aggregate data with %s and can retry', async (_case, malformed) => {
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(calls++ === 0 ? malformed : aggregation)));
  render(<MemoryRouter initialEntries={['/history/summary?filter=RECENT_10']}><AllPlayerSummaryPage /></MemoryRouter>);
  expect(await screen.findByText('全员汇总暂时无法加载；服务器已保护可见对局范围。')).toBeInTheDocument();
  expect(screen.queryByText('超长中文昵称十二人之一')).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('button', { name: '重试加载' }));
  expect(await screen.findByText('超长中文昵称十二人之一')).toBeInTheDocument();
});
