import type { GameSnapshotDto } from '@poker/contracts';
import { act, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthProvider.js';
import { jsonResponse, session } from '../../test/app-fixtures.js';
import type { GameSocketClient } from '../../api/game-socket.js';
import { GamePage } from './GamePage.js';

type Listener = (...args: unknown[]) => void;

class FakeGameSocket implements GameSocketClient {
  connected = false;
  readonly joined: Array<{ gameId: string; knownVersion: number }> = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, payload: unknown, ack?: (value: unknown) => void): this {
    if (event === 'game.join') {
      this.joined.push(payload as { gameId: string; knownVersion: number });
      ack?.({ ok: true, gameId: 'game-1', version: 1, snapshotSent: false });
    }
    return this;
  }

  connect(): this {
    this.connected = true;
    this.fire('connect');
    return this;
  }

  disconnect(): this {
    this.connected = false;
    return this;
  }

  fire(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function players(count: number): GameSnapshotDto['players'] {
  return Array.from({ length: count }, (_, index) => ({
    id: index === 0 ? 'player-self' : `player-${index + 1}`,
    userId: index === 0 ? 'user-1' : `user-${index + 1}`,
    nickname: index === 0 ? '阿明' : `牌友${index + 1}`,
    avatarUrl: `/avatars/preset-${String((index % 12) + 1).padStart(2, '0')}.webp`,
    seatNo: index + 1,
    effectiveHands: index + 1,
    buyInAmount: String((index + 1) * 300)
  }));
}

function snapshot(overrides: Partial<GameSnapshotDto> = {}): GameSnapshotDto {
  return {
    id: 'game-1', name: '8月17日晚场', status: 'ACTIVE', version: 1,
    handPrice: '300', rakeEnabled: true, startedAt: '2026-08-17T12:00:00.000Z',
    stoppedAt: null, serverNow: '2026-08-17T13:00:00.000Z', players: players(12),
    purchases: [{
      id: 'buy-self', playerId: 'player-self', actorNickname: '阿明', type: 'BUY',
      previousHands: null, newHands: 1, handsDelta: 1, createdAt: '2026-08-17T12:10:00.000Z'
    }],
    spectators: [{ userId: 'watcher-1', nickname: '观战小王', avatarUrl: '/avatars/preset-12.webp' }],
    ...overrides
  };
}

function renderGame(
  socket: FakeGameSocket,
  game = snapshot(),
  role: 'SUPER_ADMIN' | 'ADMIN' | 'USER' = 'USER'
) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session(role));
    if (url.endsWith('/api/games/game-1/snapshot')) return jsonResponse(game);
    if (url.endsWith('/api/games/game-1/begin-settlement')) return jsonResponse(snapshot({
      ...game,
      status: 'SETTLING',
      version: game.version + 1,
      stoppedAt: '2026-08-17T13:00:00.000Z'
    }));
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  const view = render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/games/game-1']}>
        <Routes><Route path="/games/:id" element={<GamePage socketFactory={() => socket} />} /></Routes>
      </MemoryRouter>
    </AuthProvider>
  );
  return { fetchMock, ...view };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('shows the full live table, spectators, tabs, and only the latest self adjustment action', async () => {
  // Break caught: the game page drops all-table data or exposes adjustment on another player's record.
  const socket = new FakeGameSocket();
  renderGame(socket);

  expect(await screen.findAllByTestId('table-seat')).toHaveLength(12);
  expect(screen.getByText('观战小王')).toBeInTheDocument();
  expect(screen.getByText('全桌总买入')).toBeInTheDocument();
  expect(screen.getByText('01:00:00')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '购买筹码' })).toBeInTheDocument();

  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: /^购买记录/ }));
  expect(screen.getByText('购买 1 手')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '更正我的最后一笔购买' })).toBeInTheDocument();
});

it('rejoins with the latest known version after a socket reconnect', async () => {
  // Break caught: reconnect starts from version zero and can overwrite a newer full snapshot.
  const socket = new FakeGameSocket();
  renderGame(socket, snapshot({ players: players(1) }));
  await screen.findByTestId('round-table');
  await waitFor(() => expect(socket.joined.at(-1)).toEqual({ gameId: 'game-1', knownVersion: 1 }));

  act(() => {
    socket.fire('game.updated', snapshot({ version: 4, players: players(1) }));
    socket.connected = false;
    socket.fire('disconnect');
    socket.connected = true;
    socket.fire('connect');
  });

  expect(socket.joined.at(-1)).toEqual({ gameId: 'game-1', knownVersion: 4 });
});

it('starts HTTP fallback five seconds after disconnect and polls every ten seconds', async () => {
  // Break caught: a dead WebSocket leaves the visible ledger stale without a clearly labelled fallback.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const socket = new FakeGameSocket();
  const { fetchMock } = renderGame(socket, snapshot({ players: players(1) }));
  await screen.findByTestId('round-table');
  await waitFor(() => expect(socket.joined).toHaveLength(1));
  const initialSnapshots = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/games/game-1/snapshot')).length;

  act(() => {
    socket.connected = false;
    socket.fire('disconnect');
  });
  act(() => {
    vi.advanceTimersByTime(5_000);
  });
  expect(screen.getByRole('status', { name: '实时连接状态' })).toHaveTextContent('定期同步');

  await act(async () => { vi.advanceTimersByTime(10_000); });
  await waitFor(() => {
    const snapshots = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/games/game-1/snapshot')).length;
    expect(snapshots).toBeGreaterThan(initialSnapshots);
  });
});

it('keeps write controls out of settling games', async () => {
  // Break caught: the UI allows a buy or adjustment after the server has entered SETTLING.
  const socket = new FakeGameSocket();
  renderGame(socket, snapshot({ status: 'SETTLING', players: players(1) }));

  await screen.findByTestId('round-table');
  expect(screen.queryByRole('button', { name: '购买筹码' })).not.toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: /^购买记录/ }));
  expect(screen.queryByRole('button', { name: '更正我的最后一笔购买' })).not.toBeInTheDocument();
});

it('lets only an administrator confirm the ACTIVE to SETTLING transition', async () => {
  // Break caught: a normal user can end the table, or an administrator ends it without the required confirmation.
  const userSocket = new FakeGameSocket();
  const userView = renderGame(userSocket, snapshot({ players: players(1) }), 'USER');
  await screen.findByTestId('round-table');
  expect(screen.queryByRole('button', { name: '结束对局' })).not.toBeInTheDocument();
  userView.unmount();

  const adminSocket = new FakeGameSocket();
  const { unmount } = renderGame(adminSocket, snapshot({ players: players(1) }), 'ADMIN');
  const user = userEvent.setup();
  const endButton = await screen.findByRole('button', { name: '结束对局' });
  await user.click(endButton);
  expect(screen.getByRole('dialog', { name: '确认结束对局' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '确认结束并进入结算' }));

  expect(await screen.findByText('结算中')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '购买筹码' })).not.toBeInTheDocument();
  unmount();
});
