import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { App } from '../../app/App.js';
import { AuthProvider } from '../../auth/AuthProvider.js';
import { currentGame, jsonResponse, renderAt, session } from '../../test/app-fixtures.js';
import { HomePage } from './HomePage.js';

afterEach(() => vi.unstubAllGlobals());

function mockHomeFetch(currentResponse: unknown, role: 'USER' | 'ADMIN' | 'SUPER_ADMIN' = 'USER') {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session(role));
    if (url.endsWith('/api/games/current')) return currentResponse instanceof Response ? currentResponse : jsonResponse(currentResponse);
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function expectOnlyCurrentRequests(fetchMock: ReturnType<typeof vi.fn>) {
  expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
    '/api/auth/session', '/api/games/current'
  ]);
}

function HistoryControls() {
  const navigate = useNavigate();
  const location = useLocation();
  return <>
    <button type="button" onClick={() => navigate('/away')}>离开首页</button>
    <button type="button" onClick={() => navigate(-1)}>返回上一页</button>
    <output data-testid="location-state">{JSON.stringify(location.state)}</output>
  </>;
}

function renderHomeState(state: unknown) {
  return render(<AuthProvider><MemoryRouter initialEntries={[{ pathname: '/', state }]}>
    <HistoryControls />
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/away" element={<p>其他页面</p>} />
    </Routes>
  </MemoryRouter></AuthProvider>);
}

it('requests only current games and omits personal summaries and recent results', async () => {
  // Break caught: home reloads personal history or renders a stale summary after the history flow moved to its own page.
  const fetchMock = mockHomeFetch({ games: [currentGame(1)] });

  renderAt('/', <App />);

  expect(await screen.findByRole('link', { name: /进入对局/ })).toHaveAttribute('href', '/games/game-1');
  expect(screen.queryByText('个人摘要')).not.toBeInTheDocument();
  expect(screen.queryByText('最近战绩')).not.toBeInTheDocument();
  expectOnlyCurrentRequests(fetchMock);
});

it('switches the home to history without loading current games and promotes monthly ranking', async () => {
  // Break caught: history remains a third bottom-nav page or both home panels fetch in the background.
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session());
    if (url.endsWith('/api/history?limit=10')) return jsonResponse({
      items: [{
        gameId: 'game-1',
        name: '8月25日早场',
        completedAt: '2026-08-25T12:00:00.000+08:00',
        settledByNickname: '西西',
        myFinalAmount: '800'
      }],
      nextCursor: null
    });
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);

  renderAt('/?tab=history', <App />);

  expect(await screen.findByRole('tab', { name: '历史战绩' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tab', { name: '当前对局' })).toHaveAttribute('aria-selected', 'false');
  expect(screen.getByRole('link', { name: /月度排名/ })).toHaveAttribute('href', '/history/monthly');
  expect(screen.getByRole('link', { name: '选择牌局' })).toHaveAttribute('href', '/history/select');
  expect(await screen.findByText('8月25日早场')).toBeInTheDocument();
  expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
    '/api/auth/session', '/api/history?limit=10'
  ]);
});

it('makes the whole current-game card a link and replaces preset portraits with nickname avatars', async () => {
  // Break caught: legacy preset portraits leak back into player-facing surfaces instead of the approved nickname initials.
  mockHomeFetch({ games: [{
    ...currentGame(1),
    players: [
      { id: 'player-1', userId: 'user-1', nickname: '西西', avatarUrl: '/avatars/preset-01.webp', seatNo: 1, effectiveHands: 3, buyInAmount: '900' },
      { id: 'player-2', userId: 'user-2', nickname: 'test', avatarUrl: '/avatars/preset-02.webp', seatNo: 2, effectiveHands: 4, buyInAmount: '1200' }
    ]
  }] });

  renderAt('/', <App />);

  const cardLink = await screen.findByRole('link', { name: '进入对局：8月17日晚场' });
  expect(cardLink).toHaveAttribute('href', '/games/game-1');
  expect(within(cardLink).getByRole('img', { name: '西西的头像' })).toHaveTextContent('西');
  expect(within(cardLink).getByRole('img', { name: 'test的头像' })).toHaveTextContent('T');
  expect(within(cardLink).queryByRole('img', { name: '西西的头像' })?.tagName).toBe('SPAN');
  expect(within(cardLink).getByText('西西、test')).toBeInTheDocument();
});

it('limits the home-card avatar and name preview to five players', async () => {
  // Break caught: the avatar stack is capped but all 12 names still inflate the card DOM.
  mockHomeFetch({ games: [{
    ...currentGame(1),
    players: Array.from({ length: 6 }, (_, index) => ({
      id: `player-${index + 1}`,
      userId: `user-${index + 1}`,
      nickname: `玩家${index + 1}`,
      avatarUrl: `/avatars/preset-0${index + 1}.webp`,
      seatNo: index + 1,
      effectiveHands: 1,
      buyInAmount: '300'
    }))
  }] });

  renderAt('/', <App />);

  const cardLink = await screen.findByRole('link', { name: '进入对局：8月17日晚场' });
  expect(within(cardLink).getAllByRole('img')).toHaveLength(5);
  expect(within(cardLink).getByText('玩家1、玩家2、玩家3、玩家4、玩家5')).toBeInTheDocument();
  expect(within(cardLink).queryByText('玩家6')).not.toBeInTheDocument();
  expect(within(cardLink).getByText('+1')).toBeInTheDocument();
});

it('shows at most five open games and reports the current capacity', async () => {
  // Break caught: the home page still truncates the server result to the former two-table limit.
  mockHomeFetch({ games: Array.from({ length: 6 }, (_, index) => currentGame(index + 1)) });

  renderAt('/', <App />);

  expect(await screen.findAllByRole('link', { name: /^进入对局：/ })).toHaveLength(5);
  expect(screen.getByText('当前 5 / 5 场')).toBeInTheDocument();
  expect(screen.queryByText('8月22日晚场')).not.toBeInTheDocument();
});

it.each(['USER', 'ADMIN', 'SUPER_ADMIN'] as const)('disables game creation for a %s when five games are already open', async (role) => {
  // Break caught: any signed-in role can enter the creation flow even though the open-table capacity is full.
  mockHomeFetch({ games: Array.from({ length: 5 }, (_, index) => currentGame(index + 1)) }, role);

  renderAt('/', <App />);

  const limit = await screen.findByText('已达 5 场上限');
  expect(limit).toHaveAttribute('aria-disabled', 'true');
  expect(screen.queryByRole('link', { name: '创建对局' })).not.toBeInTheDocument();
});

it('shows the current-game empty state without loading history', async () => {
  // Break caught: an ordinary signed-in user cannot start a table from an empty home page.
  const fetchMock = mockHomeFetch({ games: [] });

  renderAt('/', <App />);

  expect(await screen.findByText('当前没有进行中的对局')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '创建对局' })).toHaveAttribute('href', '/games/new');
  expect(screen.getByRole('link', { name: '创建一场' })).toHaveAttribute('href', '/games/new');
  expectOnlyCurrentRequests(fetchMock);
});

it('keeps the settling table usable when the current-games request succeeds', async () => {
  const fetchMock = mockHomeFetch({ games: [{ ...currentGame(1), status: 'SETTLING' }] });

  renderAt('/', <App />);

  expect(await screen.findByRole('link', { name: /进入对局/ })).toHaveAttribute('href', '/games/game-1');
  expect(screen.getByText('结算中')).toBeInTheDocument();
  expectOnlyCurrentRequests(fetchMock);
});

it('shows the current-games error without loading history', async () => {
  const fetchMock = mockHomeFetch(jsonResponse({ code: 'INTERNAL_ERROR' }, 500));

  renderAt('/', <App />);

  expect(await screen.findByText('当前对局暂时无法加载，请稍后重试')).toBeInTheDocument();
  expectOnlyCurrentRequests(fetchMock);
});

it('shows the hard-delete notice once, clears the same history state, and does not repeat it after back navigation', async () => {
  // Break caught: the deletion notice disappears with history-state cleanup or reappears whenever the user returns home.
  mockHomeFetch({ games: [] });
  renderHomeState({ notice: '该对局已由超级管理员删除' });

  expect(await screen.findByRole('status', { name: '对局删除提示' })).toHaveTextContent('该对局已由超级管理员删除');
  await waitFor(() => expect(screen.getByTestId('location-state')).toHaveTextContent('null'));

  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '离开首页' }));
  expect(screen.getByText('其他页面')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '返回上一页' }));
  expect(await screen.findByText('当前没有进行中的对局')).toBeInTheDocument();
  expect(screen.queryByRole('status', { name: '对局删除提示' })).not.toBeInTheDocument();
});

it.each([
  null,
  { notice: '普通通知' },
  { notice: '该对局已由超级管理员删除', extra: true },
  { from: '/games/game-1' }
])('does not render ordinary navigation state as a deletion notice: %j', async (state) => {
  // Break caught: arbitrary router state becomes a trusted user-visible deletion message.
  mockHomeFetch({ games: [] });
  renderHomeState(state);
  expect(await screen.findByText('当前没有进行中的对局')).toBeInTheDocument();
  expect(screen.queryByRole('status', { name: '对局删除提示' })).not.toBeInTheDocument();
});
