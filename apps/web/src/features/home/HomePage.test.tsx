import { screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App.js';
import { currentGame, jsonResponse, renderAt, session } from '../../test/app-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

it('requests only current games and omits personal summaries and recent results', async () => {
  // Break caught: home reloads personal history or renders a stale summary after the history flow moved to its own page.
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('USER'));
    if (url.endsWith('/api/games/current')) return jsonResponse({ games: [currentGame(1)] });
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);

  renderAt('/', <App />);

  expect(await screen.findByRole('link', { name: /进入对局/ })).toHaveAttribute('href', '/games/game-1');
  expect(screen.queryByText('个人摘要')).not.toBeInTheDocument();
  expect(screen.queryByText('最近战绩')).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
    '/api/auth/session', '/api/games/current'
  ]);
});
