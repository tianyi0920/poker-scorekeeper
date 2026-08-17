import { screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App.js';
import { currentGame, historyGame, jsonResponse, renderAt, session } from '../../test/app-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

it('renders no more than two current games and the latest ten real history rows', async () => {
  // Break caught: home ignores the API collections or renders an unbounded history list.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('USER'));
    if (url.endsWith('/api/games/current')) return jsonResponse({ games: [currentGame(1), currentGame(2)] });
    if (url.endsWith('/api/history?limit=10')) {
      return jsonResponse({ games: Array.from({ length: 12 }, (_, index) => historyGame(index + 1)), nextCursor: null });
    }
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));

  renderAt('/', <App />);

  expect(await screen.findAllByRole('link', { name: /进入对局/ })).toHaveLength(2);
  expect(screen.getAllByTestId('recent-result')).toHaveLength(10);
  expect(screen.getByText('近 10 场最终金额')).toBeInTheDocument();
});

it('shows an honest empty state instead of sample games when no current game exists', async () => {
  // Break caught: production UI fills an empty response with demo or hard-coded games.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('USER'));
    if (url.endsWith('/api/games/current')) return jsonResponse({ games: [] });
    if (url.endsWith('/api/history?limit=10')) return jsonResponse({ games: [], nextCursor: null });
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));

  renderAt('/', <App />);

  expect(await screen.findByText('当前没有进行中的对局')).toBeInTheDocument();
  expect(screen.getByText('还没有历史战绩')).toBeInTheDocument();
});
