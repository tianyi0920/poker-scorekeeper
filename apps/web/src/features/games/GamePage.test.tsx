import type { GameSnapshotDto } from '@poker/contracts';
import { act, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate, useNavigationType } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthProvider.js';
import { jsonResponse, session } from '../../test/app-fixtures.js';
import type { GameSocketClient } from '../../api/game-socket.js';
import { GamePage } from './GamePage.js';

type Listener = (...args: unknown[]) => void;

class FakeGameSocket implements GameSocketClient {
  connected = false;
  readonly joined: Array<{ gameId: string; knownVersion: number }> = [];
  leaves = 0;
  joinAcknowledgement: ((payload: { gameId: string; knownVersion: number }) => unknown | undefined) = (payload) => ({
    ok: true, gameId: payload.gameId, version: Math.max(1, payload.knownVersion), snapshotSent: false
  });
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
      const command = payload as { gameId: string; knownVersion: number };
      this.joined.push(command);
      const acknowledgement = this.joinAcknowledgement(command);
      if (acknowledgement !== undefined) ack?.(acknowledgement);
    }
    if (event === 'game.leave') this.leaves += 1;
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

  listenerCount(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
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
        <Routes>
          <Route path="/games/:id" element={<GamePage socketFactory={() => socket} />} />
          <Route path="/games/:id/settlement" element={<SettlementDestination />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  );
  return { fetchMock, ...view };
}

function SettlementDestination() {
  return <div>已进入结算页 <span data-testid="settlement-navigation-type">{useNavigationType()}</span></div>;
}

function SwitchableGame({ socketFactory }: { socketFactory: () => GameSocketClient }) {
  const navigate = useNavigate();
  return <><button type="button" onClick={() => navigate('/games/game-2')}>切换到第二桌</button><GamePage socketFactory={socketFactory} /></>;
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

it('implements linked tabs with roving focus and arrow-key selection', async () => {
  // Break caught: visual tabs lack programmatic panel ownership or cannot be operated without pointer input.
  const socket = new FakeGameSocket();
  renderGame(socket, snapshot({ players: players(1) }));
  const tableTab = await screen.findByRole('tab', { name: '对战区' });
  const purchaseTab = screen.getByRole('tab', { name: /^购买记录/ });

  expect(tableTab).toHaveAttribute('aria-controls', 'game-panel-table');
  expect(tableTab).toHaveAttribute('tabindex', '0');
  expect(purchaseTab).toHaveAttribute('tabindex', '-1');
  expect(screen.getByRole('tabpanel', { name: '对战区' })).toHaveAttribute('id', 'game-panel-table');

  tableTab.focus();
  await userEvent.setup().keyboard('{ArrowRight}');
  expect(purchaseTab).toHaveFocus();
  expect(purchaseTab).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tabpanel', { name: /^购买记录/ })).toHaveAttribute('id', 'game-panel-purchases');
  await userEvent.setup().keyboard('{Home}');
  expect(tableTab).toHaveFocus();
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

it.each([
  ['negative', { ok: false, code: 'FORBIDDEN' }],
  ['invalid', { ok: true, gameId: 'game-1' }]
])('keeps a %s join acknowledgement unsynchronized, falls back, and later rejoins', async (_kind, firstAck) => {
  // Break caught: transport connection hides a rejected or malformed room join and leaves the ledger stale.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const socket = new FakeGameSocket();
  socket.joinAcknowledgement = () => firstAck;
  const { fetchMock } = renderGame(socket, snapshot({ players: players(1) }));
  await screen.findByTestId('round-table');
  await waitFor(() => expect(socket.joined).toHaveLength(1));
  await waitFor(() => {
    expect(screen.getByRole('status', { name: '实时连接状态' }))
      .toHaveTextContent('实时房间同步失败');
  });
  const initialSnapshots = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/snapshot')).length;

  // The fallback effect is installed after the failed ACK render, so allow its
  // five-second delay plus one scheduler turn instead of assuming timer epoch 0.
  await act(async () => { vi.advanceTimersByTime(5_100); });
  await waitFor(() => {
    expect(screen.getByRole('status', { name: '实时连接状态' })).toHaveTextContent('定期同步');
  });
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/snapshot')).length).toBeGreaterThan(initialSnapshots);

  socket.joinAcknowledgement = (command) => ({
    ok: true, gameId: command.gameId, version: command.knownVersion, snapshotSent: false
  });
  await act(async () => { vi.advanceTimersByTime(5_000); });
  expect(socket.joined.length).toBeGreaterThanOrEqual(2);
  expect(screen.queryByRole('status', { name: '实时连接状态' })).not.toBeInTheDocument();
});

it('times out a silent room join and cleans all retry work on unmount', async () => {
  // Break caught: a connected transport with no join ACK is reported healthy and leaves orphan retry timers after navigation.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const socket = new FakeGameSocket();
  socket.joinAcknowledgement = () => undefined;
  const { unmount } = renderGame(socket, snapshot({ players: players(1) }));
  await screen.findByTestId('round-table');
  await waitFor(() => expect(socket.joined).toHaveLength(1));

  await act(async () => { vi.advanceTimersByTime(3_000); });
  expect(screen.getByRole('status', { name: '实时连接状态' })).toHaveTextContent('超时');
  unmount();
  const joinsAtUnmount = socket.joined.length;
  await act(async () => { vi.advanceTimersByTime(30_000); });

  expect(socket.joined).toHaveLength(joinsAtUnmount);
  expect(socket.listenerCount()).toBe(0);
});

it('ignores malformed realtime events and reacts only to shared-contract payloads', async () => {
  // Break caught: an arbitrary Socket payload triggers a refresh or disconnect without passing the shared event schema.
  const socket = new FakeGameSocket();
  const { fetchMock } = renderGame(socket, snapshot({ players: players(1) }));
  await screen.findByTestId('round-table');
  await waitFor(() => expect(socket.joined).toHaveLength(1));
  const initialSnapshots = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/snapshot')).length;

  act(() => {
    socket.fire('rake-settings.updated', { unexpected: true });
    socket.fire('player-rake.updated', { unexpected: true });
    socket.fire('server.error', { code: 'NOT_A_REAL_CODE' });
  });
  await act(async () => { await Promise.resolve(); });
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/snapshot'))).toHaveLength(initialSnapshots);
  expect(screen.queryByRole('status', { name: '实时连接状态' })).not.toBeInTheDocument();

  act(() => { socket.fire('rake-settings.updated', { version: 2 }); });
  await waitFor(() => {
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/snapshot')).length).toBeGreaterThan(initialSnapshots);
  });
  act(() => { socket.fire('server.error', { code: 'INTERNAL_ERROR' }); });
  expect(screen.getByRole('status', { name: '实时连接状态' })).toBeInTheDocument();
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

it('closes an open purchase sheet immediately when a realtime snapshot starts settlement', async () => {
  // Break caught: a sheet opened during ACTIVE survives a SETTLING update and retains stale write controls.
  const socket = new FakeGameSocket();
  renderGame(socket, snapshot({ players: players(1) }));
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '购买筹码' }));
  expect(screen.getByRole('dialog', { name: '购买筹码' })).toBeInTheDocument();

  act(() => { socket.fire('game.updated', snapshot({ status: 'SETTLING', version: 2, players: players(1) })); });
  expect(screen.queryByRole('dialog', { name: '购买筹码' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '购买筹码' })).not.toBeInTheDocument();
});

it('closes an open adjustment dialog immediately when a realtime snapshot starts settlement', async () => {
  // Break caught: a correction dialog remains writable after settlement begins.
  const socket = new FakeGameSocket();
  renderGame(socket, snapshot({ players: players(1) }));
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: /^购买记录/ }));
  await user.click(screen.getByRole('button', { name: '更正我的最后一笔购买' }));
  expect(screen.getByRole('dialog', { name: '更正最后一笔购买' })).toBeInTheDocument();

  act(() => { socket.fire('game.updated', snapshot({ status: 'SETTLING', version: 2, players: players(1) })); });
  expect(screen.queryByRole('dialog', { name: '更正最后一笔购买' })).not.toBeInTheDocument();
});

it('resets snapshot version state before loading a different game route', async () => {
  // Break caught: a high version from the previous route rejects a valid lower-version snapshot for the new game.
  const sockets: FakeGameSocket[] = [];
  const gameOne = snapshot({ id: 'game-1', name: '第一桌', version: 9, players: players(1) });
  const gameTwo = snapshot({ id: 'game-2', name: '第二桌', version: 1, players: [{ ...players(1)[0]!, id: 'player-game-2' }] });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session());
    if (url.endsWith('/api/games/game-1/snapshot')) return jsonResponse(gameOne);
    if (url.endsWith('/api/games/game-2/snapshot')) return jsonResponse(gameTwo);
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/games/game-1']}>
        <Routes><Route path="/games/:id" element={<SwitchableGame socketFactory={() => {
          const socket = new FakeGameSocket();
          sockets.push(socket);
          return socket;
        }} />} /></Routes>
      </MemoryRouter>
    </AuthProvider>
  );
  expect(await screen.findByRole('heading', { name: '第一桌' })).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('button', { name: '切换到第二桌' }));

  expect(await screen.findByRole('heading', { name: '第二桌' })).toBeInTheDocument();
  await waitFor(() => expect(sockets.at(-1)?.joined.at(-1)).toEqual({ gameId: 'game-2', knownVersion: 1 }));
});

it('lets only an administrator confirm the ACTIVE to SETTLING transition and then enters settlement', async () => {
  // Break caught: a normal user can end the table, or an administrator needs a second navigation action after confirmation.
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

  expect(await screen.findByText('已进入结算页')).toBeInTheDocument();
  expect(screen.getByTestId('settlement-navigation-type')).toHaveTextContent('REPLACE');
  expect(screen.queryByRole('link', { name: '进入结算' })).not.toBeInTheDocument();
  unmount();
});

it('gives an administrator a settlement recovery entry when the loaded game is already SETTLING', async () => {
  // Break caught: reload after a successful transition strands the administrator on the table page.
  const socket = new FakeGameSocket();
  renderGame(socket, snapshot({ status: 'SETTLING', stoppedAt: '2026-08-17T13:00:00.000Z' }), 'ADMIN');
  expect(await screen.findByRole('link', { name: '继续结算' })).toHaveAttribute('href', '/games/game-1/settlement');
});

it.each(['DRAFT', 'COMPLETED', 'VOIDED'] as const)('does not offer settlement recovery for a %s game', async (status) => {
  // Break caught: every non-ACTIVE status was treated as SETTLING and exposed an invalid settlement route.
  const socket = new FakeGameSocket();
  renderGame(socket, snapshot({ status, players: players(1) }), 'ADMIN');
  await screen.findByTestId('round-table');
  expect(screen.queryByRole('link', { name: '继续结算' })).not.toBeInTheDocument();
});

it('keeps the end confirmation open after a failed begin-settlement request and permits retry', async () => {
  // Break caught: a transient write failure closes the only retry control or prevents the later successful replace navigation.
  let attempts = 0;
  const socket = new FakeGameSocket();
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('ADMIN'));
    if (url.endsWith('/api/games/game-1/snapshot')) return jsonResponse(snapshot({ players: players(1) }));
    if (url.endsWith('/api/games/game-1/begin-settlement')) {
      attempts += 1;
      return attempts === 1
        ? jsonResponse({ code: 'TEMPORARY' }, 500)
        : jsonResponse(snapshot({ status: 'SETTLING', version: 2, stoppedAt: '2026-08-17T13:00:00.000Z', players: players(1) }));
    }
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));
  render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1']}><Routes><Route path="/games/:id" element={<GamePage socketFactory={() => socket} />} /><Route path="/games/:id/settlement" element={<SettlementDestination />} /></Routes></MemoryRouter></AuthProvider>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '结束对局' }));
  await user.click(screen.getByRole('button', { name: '确认结束并进入结算' }));
  expect(await screen.findByRole('dialog', { name: '确认结束对局' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '确认结束并进入结算' }));
  expect(await screen.findByText('已进入结算页')).toBeInTheDocument();
  expect(screen.getByTestId('settlement-navigation-type')).toHaveTextContent('REPLACE');
  expect(attempts).toBe(2);
});

it('recovers a SETTLING snapshot after a competing transition or lost begin-settlement response', async () => {
  // Break caught: another committed transition followed by a lost response leaves no way to resume settlement.
  let snapshotReads = 0;
  const socket = new FakeGameSocket();
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('ADMIN'));
    if (url.endsWith('/api/games/game-1/snapshot')) {
      snapshotReads += 1;
      return jsonResponse(snapshot(snapshotReads === 1 ? { players: players(1) } : { status: 'SETTLING', version: 2, stoppedAt: '2026-08-17T13:00:00.000Z', players: players(1) }));
    }
    if (url.endsWith('/api/games/game-1/begin-settlement')) return jsonResponse({ code: 'INVALID_GAME_TRANSITION' }, 409);
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));
  render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1']}><Routes><Route path="/games/:id" element={<GamePage socketFactory={() => socket} />} /><Route path="/games/:id/settlement" element={<SettlementDestination />} /></Routes></MemoryRouter></AuthProvider>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '结束对局' }));
  await user.click(screen.getByRole('button', { name: '确认结束并进入结算' }));
  expect(await screen.findByRole('link', { name: '继续结算' })).toHaveAttribute('href', '/games/game-1/settlement');
  expect(snapshotReads).toBeGreaterThanOrEqual(2);
});
