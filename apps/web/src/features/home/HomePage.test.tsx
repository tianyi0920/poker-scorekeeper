import { screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App.js';
import { currentGame, jsonResponse, renderAt, session } from '../../test/app-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

function mockHomeFetch(currentResponse: unknown) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('USER'));
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

it('requests only current games and omits personal summaries and recent results', async () => {
  // Break caught: home reloads personal history or renders a stale summary after the history flow moved to its own page.
  const fetchMock = mockHomeFetch({ games: [currentGame(1)] });

  renderAt('/', <App />);

  expect(await screen.findByRole('link', { name: /进入对局/ })).toHaveAttribute('href', '/games/game-1');
  expect(screen.queryByText('个人摘要')).not.toBeInTheDocument();
  expect(screen.queryByText('最近战绩')).not.toBeInTheDocument();
  expectOnlyCurrentRequests(fetchMock);
});

it('shows the current-game empty state without loading history', async () => {
  const fetchMock = mockHomeFetch({ games: [] });

  renderAt('/', <App />);

  expect(await screen.findByText('当前没有进行中的对局')).toBeInTheDocument();
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
