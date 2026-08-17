import { screen, within } from '@testing-library/react';
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

it('keeps current tables usable when recent history fails and labels settling tables', async () => {
  // Break caught: one rejected home request discarded the successful current-table response.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('USER'));
    if (url.endsWith('/api/games/current')) return jsonResponse({ games: [{ ...currentGame(1), status: 'SETTLING' }] });
    if (url.endsWith('/api/history?limit=10')) return jsonResponse({ code: 'INTERNAL_ERROR' }, 500);
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));

  renderAt('/', <App />);

  expect(await screen.findByRole('link', { name: /进入对局/ })).toHaveAttribute('href', '/games/game-1');
  expect(screen.getByText('结算中')).toBeInTheDocument();
  expect(await screen.findByText('最近战绩暂时无法加载，请稍后重试')).toBeInTheDocument();
});

it('keeps history and the personal summary visible when current tables fail', async () => {
  // Break caught: one rejected home request discarded successful history and its personal summary.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('USER'));
    if (url.endsWith('/api/games/current')) return jsonResponse({ code: 'INTERNAL_ERROR' }, 500);
    if (url.endsWith('/api/history?limit=10')) return jsonResponse({ games: [historyGame(2)], nextCursor: null });
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));

  renderAt('/', <App />);

  expect(await screen.findByTestId('recent-result')).toBeInTheDocument();
  expect(screen.getByText('当前对局暂时无法加载，请稍后重试')).toBeInTheDocument();
  const summary = screen.getByText('近 10 场最终金额').closest('section')!;
  expect(within(summary).getByText('100')).toBeInTheDocument();
});

it('sums positive, negative and null history amounts exactly beyond MAX_SAFE_INTEGER', async () => {
  // Break caught: Number-based totals silently rounded large money values and treated null ambiguously.
  const history = [
    { ...historyGame(1), id: 'large-positive', myFinalAmount: '9007199254740993000' },
    { ...historyGame(2), id: 'large-negative', myFinalAmount: '-9007199254740992999' },
    { ...historyGame(3), id: 'not-seated', myFinalAmount: null }
  ];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('USER'));
    if (url.endsWith('/api/games/current')) return jsonResponse({ games: [] });
    if (url.endsWith('/api/history?limit=10')) return jsonResponse({ games: history, nextCursor: null });
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));

  renderAt('/', <App />);

  await screen.findAllByTestId('recent-result');
  const summary = screen.getByText('近 10 场最终金额').closest('section')!;
  expect(within(summary).getByText('1')).toBeInTheDocument();
  expect(screen.getByText('未参战')).toBeInTheDocument();
});
