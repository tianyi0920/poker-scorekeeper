import type { GameMessageDto, GameSnapshotDto } from '@poker/contracts';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthProvider.js';
import { jsonResponse, session } from '../../test/app-fixtures.js';
import type { GameSocketClient } from '../../api/game-socket.js';
import { GamePage, mergeGameMessageWindow } from './GamePage.js';

type Listener = (...args: unknown[]) => void;

class FakeGameSocket implements GameSocketClient {
  connected = false;
  autoConnect = true;
  deferJoinAcknowledgements = false;
  readonly joined: Array<{ gameId: string; knownVersion: number }> = [];
  leaves = 0;
  joinAcknowledgement: ((payload: { gameId: string; knownVersion: number }) => unknown | undefined) = (payload) => ({
    ok: true, gameId: payload.gameId, version: Math.max(1, payload.knownVersion), snapshotSent: false
  });
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly deferredJoinAcknowledgements: Array<() => void> = [];

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
      if (acknowledgement !== undefined && ack !== undefined) {
        const deliverAcknowledgement = () => ack(acknowledgement);
        if (this.deferJoinAcknowledgements) {
          this.deferredJoinAcknowledgements.push(deliverAcknowledgement);
        } else {
          deliverAcknowledgement();
        }
      }
    }
    if (event === 'game.leave') this.leaves += 1;
    return this;
  }

  connect(): this {
    if (!this.autoConnect) return this;
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

  listenerCount(event?: string): number {
    if (event !== undefined) return this.listeners.get(event)?.size ?? 0;
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }

  acknowledgeDeferredJoin(): void {
    const acknowledgement = this.deferredJoinAcknowledgements.shift();
    if (acknowledgement === undefined) throw new Error('No deferred game.join acknowledgement');
    acknowledgement();
  }

  acknowledgeLatestDeferredJoin(): void {
    const acknowledgement = this.deferredJoinAcknowledgements.pop();
    if (acknowledgement === undefined) throw new Error('No deferred game.join acknowledgement');
    acknowledgement();
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

function message(overrides: Partial<GameMessageDto> = {}): GameMessageDto {
  return {
    id: '018f5d0d-43a8-7a7a-9b0b-0e8d9de76e01',
    gameId: 'game-1',
    userId: 'user-1',
    nickname: '阿明',
    avatarUrl: '/avatars/preset-01.webp',
    text: '马上到',
    createdAt: '2026-08-24T09:00:00.000Z',
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeSpeechSynthesisUtterance {
  lang = '';
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }
}

function installSpeechSynthesis() {
  const spoken: FakeSpeechSynthesisUtterance[] = [];
  let cancelCount = 0;
  vi.stubGlobal('SpeechSynthesisUtterance', FakeSpeechSynthesisUtterance);
  vi.stubGlobal('speechSynthesis', {
    speak: (utterance: FakeSpeechSynthesisUtterance) => { spoken.push(utterance); },
    cancel: () => { cancelCount += 1; }
  });
  return { spoken, get cancelCount() { return cancelCount; } };
}

function renderGame(
  socket: FakeGameSocket,
  game = snapshot(),
  role: 'SUPER_ADMIN' | 'ADMIN' | 'USER' = 'USER',
  initialMessages: GameMessageDto[] = []
) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session(role));
    if (url.endsWith('/api/games/game-1/snapshot')) return jsonResponse(game);
    if (url.endsWith('/api/games/game-1/begin-settlement')) return jsonResponse(snapshot({
      ...game,
      status: 'SETTLING',
      version: game.version + 1,
      stoppedAt: '2026-08-17T13:00:00.000Z'
    }));
    if (url.endsWith('/api/games/game-1/messages')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { text: string };
        return jsonResponse(message({ text: body.text.trim() }));
      }
      return jsonResponse({ gameId: 'game-1', messages: initialMessages });
    }
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  const view = render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/games/game-1']}>
        <Routes>
          <Route path="/games/:id" element={<GamePage socketFactory={() => socket} />} />
          <Route path="/games/:id/settlement" element={<SettlementDestination />} />
          <Route path="/" element={<DeletedGameDestination />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  );
  return { fetchMock, ...view };
}

function SettlementDestination() {
  return <div>已进入结算页 <span data-testid="settlement-navigation-type">{useNavigationType()}</span></div>;
}

function DeletedGameDestination({ onRender }: { onRender?: () => void }) {
  const location = useLocation();
  onRender?.();
  return <div>
    已返回首页
    <span data-testid="deleted-navigation-type">{useNavigationType()}</span>
    <span data-testid="deleted-navigation-state">{JSON.stringify(location.state)}</span>
  </div>;
}

function SwitchableGame({ socketFactory }: { socketFactory: () => GameSocketClient }) {
  const navigate = useNavigate();
  return <><button type="button" onClick={() => navigate('/games/game-2')}>切换到第二桌</button><GamePage socketFactory={socketFactory} /></>;
}

afterEach(() => {
  localStorage.clear();
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
  expect(screen.getByText('总买入')).toBeInTheDocument();
  expect(screen.getByText('01:00:00')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '购买筹码' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '返回首页' })).toHaveAttribute('href', '/');
  const latestPurchase = screen.getByRole('status', { name: '最新购买记录' });
  expect(latestPurchase).toHaveTextContent('阿明');
  expect(latestPurchase).toHaveTextContent('购买 1 手');
  expect(latestPurchase).toHaveTextContent('¥300');
  const spectatorBar = screen.getByRole('region', { name: '观战区' });
  expect(spectatorBar.compareDocumentPosition(screen.getByTestId('round-table')) & Node.DOCUMENT_POSITION_FOLLOWING)
    .toBeTruthy();

  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: /^购买记录/ }));
  expect(screen.getByText('购买 1 手')).toBeInTheDocument();
  expect(screen.getByText('−¥300')).toHaveClass('money--negative');
  expect(screen.getByRole('button', { name: '更正我的最后一笔购买' })).toBeInTheDocument();
});

it('shows three simple tabs and sends one current-game message from the speech sheet', async () => {
  // Break caught: the approved message tab or send sheet is missing, or a successful send is duplicated.
  const socket = new FakeGameSocket();
  const { fetchMock } = renderGame(socket, snapshot({ players: players(1) }));
  const user = userEvent.setup();

  expect(await screen.findByRole('tab', { name: '竞技区' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tab', { name: /^购买记录/ })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: '消息区 0' })).toBeInTheDocument();
  expect(screen.queryByText(/未读/)).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '发言' }));
  expect(screen.getByRole('dialog', { name: '发言' })).toBeInTheDocument();
  await user.type(screen.getByRole('textbox', { name: '发言内容' }), '  马上到  ');
  await user.click(screen.getByRole('button', { name: '发送' }));

  await waitFor(() => expect(screen.queryByRole('dialog', { name: '发言' })).not.toBeInTheDocument());
  expect(screen.getByRole('tab', { name: '消息区 1' })).toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: '消息区 1' }));
  expect(screen.getAllByText('马上到')).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/games/game-1/messages',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: '马上到' }) })
  );
});

it('keeps voice announcements off until the speaker is explicitly enabled', async () => {
  // Break caught: entering a table starts reading private table activity without the user's consent.
  const speech = installSpeechSynthesis();
  const socket = new FakeGameSocket();
  renderGame(socket, snapshot({ players: players(1) }));

  const toggle = await screen.findByRole('button', { name: '开启语音播报' });
  expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(speech.spoken).toEqual([]);

  await userEvent.setup().click(toggle);

  expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect(toggle).toHaveAccessibleName('关闭语音播报');
  expect(speech.spoken).toEqual([
    expect.objectContaining({ text: '语音播报已开启', lang: 'zh-CN' })
  ]);
});

it('keeps the current table layout and places the speaker in the upper game heading', async () => {
  // Break caught: the speaker consumes a fourth column beside the three approved content tabs.
  renderGame(new FakeGameSocket(), snapshot({ players: players(1) }));

  const heading = (await screen.findByRole('heading', { name: '8月17日晚场' })).closest('header');
  expect(heading).not.toBeNull();
  expect(within(heading as HTMLElement).getByRole('button', { name: '开启语音播报' }))
    .toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('tablist', { name: '对局内容' })).toHaveTextContent('竞技区购买记录 1消息区 0');
});

it('does not persist the speaker preference after the page remounts', async () => {
  // Break caught: a browser refresh restores an enabled icon even though speech needs a fresh user gesture.
  installSpeechSynthesis();
  const firstView = renderGame(new FakeGameSocket(), snapshot({ players: players(1) }));
  const user = userEvent.setup();

  await user.click(await screen.findByRole('button', { name: '开启语音播报' }));
  expect(localStorage.getItem('poker-scorekeeper:voice-enabled:v1')).toBeNull();
  firstView.unmount();

  renderGame(new FakeGameSocket(), snapshot({ players: players(1) }));

  expect(await screen.findByRole('button', { name: '开启语音播报' }))
    .toHaveAttribute('aria-pressed', 'false');
});

it('embeds the local equity controls in the live table instead of adding a navigation tab', async () => {
  // Break caught: the approved calculator becomes a separate bottom destination or is missing from the arena.
  renderGame(new FakeGameSocket(), snapshot({ players: players(2) }));

  expect(await screen.findByRole('button', { name: '选择翻牌，第1张' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '为我选择手牌' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '为牌友2选择手牌' })).toBeInTheDocument();
  expect(screen.getByRole('status', { name: '胜率计算状态' })).toHaveTextContent('选择至少2名玩家手牌');
  expect(screen.getByRole('tablist', { name: '对局内容' })).toHaveTextContent('竞技区购买记录 1消息区 0');
  expect(screen.queryByRole('tab', { name: /胜率/ })).not.toBeInTheDocument();
});

it('keeps locally selected cards when checking another game tab', async () => {
  // Break caught: reviewing purchases or messages silently clears the in-progress local equity comparison.
  const user = userEvent.setup();
  renderGame(new FakeGameSocket(), snapshot({ players: players(2) }));

  await user.click(await screen.findByRole('button', { name: '为我选择手牌' }));
  await user.click(screen.getByRole('button', { name: '选择点数 A' }));
  await user.click(screen.getByRole('button', { name: '选择花色 黑桃' }));
  await user.click(screen.getByRole('button', { name: '选择点数 K' }));
  await user.click(screen.getByRole('button', { name: '选择花色 红桃' }));
  await user.click(screen.getByRole('button', { name: '确认选牌' }));

  await user.click(screen.getByRole('tab', { name: /^购买记录/ }));
  await user.click(screen.getByRole('tab', { name: '竞技区' }));

  expect(screen.getByRole('button', { name: '为我修改手牌，A黑桃 K红桃' })).toBeInTheDocument();
});

it('announces each new purchase or adjustment once without replaying the existing timeline', async () => {
  // Break caught: enabling voice replays old purchases or duplicate snapshots read the same purchase repeatedly.
  const speech = installSpeechSynthesis();
  const socket = new FakeGameSocket();
  const initial = snapshot({ players: players(2) });
  renderGame(socket, initial);
  await userEvent.setup().click(await screen.findByRole('button', { name: '开启语音播报' }));
  speech.spoken.length = 0;

  const purchase = {
    id: 'buy-player-2', playerId: 'player-2', actorNickname: '阿明', type: 'BUY' as const,
    previousHands: null, newHands: 4, handsDelta: 2, createdAt: '2026-08-17T12:20:00.000Z'
  };
  act(() => {
    socket.fire('game.updated', snapshot({ ...initial, version: 2, purchases: [...initial.purchases, purchase] }));
    socket.fire('game.updated', snapshot({ ...initial, version: 2, purchases: [...initial.purchases, purchase] }));
  });

  expect(speech.spoken.map(({ text }) => text)).toEqual(['牌友2购买 2 手，共 600 元']);

  act(() => socket.fire('game.updated', snapshot({
    ...initial,
    version: 3,
    purchases: [...initial.purchases, purchase, {
      id: 'adjust-player-2', playerId: 'player-2', actorNickname: '牌友2', type: 'ADJUST',
      previousHands: 4, newHands: 5, handsDelta: 1, createdAt: '2026-08-17T12:21:00.000Z'
    }]
  })));

  expect(speech.spoken.map(({ text }) => text)).toEqual([
    '牌友2购买 2 手，共 600 元',
    '牌友2更正为 5 手'
  ]);
});

it('announces one new current-game message with its sender', async () => {
  // Break caught: duplicate socket delivery either stays silent or reads the same chat message twice.
  const speech = installSpeechSynthesis();
  const socket = new FakeGameSocket();
  renderGame(socket, snapshot({ players: players(2) }));
  await userEvent.setup().click(await screen.findByRole('button', { name: '开启语音播报' }));
  speech.spoken.length = 0;

  const incoming = message({
    id: '018f5d0d-43a8-7a7a-9b0b-0e8d9de76e02',
    userId: 'user-2',
    nickname: '牌友2',
    text: '马上到'
  });
  act(() => {
    socket.fire('game.message.created', incoming);
    socket.fire('game.message.created', incoming);
  });

  expect(speech.spoken.map(({ text }) => text)).toEqual(['牌友2说：马上到']);
});

it('does not announce a historical message when the socket redelivers it', async () => {
  // Break caught: the initial REST message window is not added to voice de-duplication state.
  const speech = installSpeechSynthesis();
  const socket = new FakeGameSocket();
  const historical = message({ text: '刚才已经说过了' });
  renderGame(socket, snapshot({ players: players(2) }), 'USER', [historical]);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: /消息区 1/ }));
  expect(await screen.findByText('刚才已经说过了')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '开启语音播报' }));
  speech.spoken.length = 0;

  act(() => socket.fire('game.message.created', historical));

  expect(speech.spoken).toEqual([]);
});

it('never announces the initial message window when it arrives after voice is enabled', async () => {
  // Break caught: a slow initial message request turns historical chat into live speech after a quick toggle.
  const speech = installSpeechSynthesis();
  const socket = new FakeGameSocket();
  const initialMessages = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return Promise.resolve(jsonResponse(session()));
    if (url.endsWith('/api/games/game-1/snapshot')) {
      return Promise.resolve(jsonResponse(snapshot({ players: players(2) })));
    }
    if (url.endsWith('/api/games/game-1/messages')) return initialMessages.promise;
    return Promise.resolve(jsonResponse({ code: 'NOT_FOUND' }, 404));
  }));
  render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1']}><Routes>
    <Route path="/games/:id" element={<GamePage socketFactory={() => socket} />} />
  </Routes></MemoryRouter></AuthProvider>);
  await userEvent.setup().click(await screen.findByRole('button', { name: '开启语音播报' }));
  speech.spoken.length = 0;

  await act(async () => {
    initialMessages.resolve(jsonResponse({
      gameId: 'game-1',
      messages: [message({ text: '加载前就存在的消息' })]
    }));
    await initialMessages.promise;
  });

  expect(speech.spoken).toEqual([]);
});

it('announces a new message found by fallback polling only once', async () => {
  // Break caught: the disconnected fallback refreshes messages on screen but never sends them to voice playback.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const speech = installSpeechSynthesis();
  const socket = new FakeGameSocket();
  const { fetchMock } = renderGame(socket, snapshot({ players: players(2) }));
  await screen.findByTestId('round-table');
  await waitFor(() => expect(socket.joined).toHaveLength(1));
  await userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    .click(screen.getByRole('button', { name: '开启语音播报' }));
  speech.spoken.length = 0;
  const originalFetch = fetchMock.getMockImplementation()!;
  const polled = message({
    id: '018f5d0d-43a8-7a7a-9b0b-0e8d9de76e04',
    nickname: '牌友2',
    text: '断线时发来的消息'
  });
  fetchMock.mockImplementation(async (input, init) => (
    String(input).endsWith('/api/games/game-1/messages') && init?.method !== 'POST'
      ? jsonResponse({ gameId: 'game-1', messages: [polled] })
      : originalFetch(input, init)
  ));

  act(() => {
    socket.connected = false;
    socket.fire('disconnect');
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(speech.spoken.map(({ text }) => text)).toEqual(['牌友2说：断线时发来的消息']);

  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(speech.spoken.map(({ text }) => text)).toEqual(['牌友2说：断线时发来的消息']);
});

it('announces spectator entries and exits without reading the initial spectator list', async () => {
  // Break caught: enabling voice reads everyone already online or misses one side of a presence change.
  const speech = installSpeechSynthesis();
  const socket = new FakeGameSocket();
  renderGame(socket, snapshot({ players: players(1) }));
  await userEvent.setup().click(await screen.findByRole('button', { name: '开启语音播报' }));
  speech.spoken.length = 0;

  const newcomer = { userId: 'watcher-2', nickname: '观战小李', avatarUrl: '/avatars/preset-11.webp' };
  act(() => socket.fire('presence.updated', {
    gameId: 'game-1',
    spectators: [...snapshot().spectators, newcomer]
  }));
  act(() => socket.fire('presence.updated', { gameId: 'game-1', spectators: [newcomer] }));

  expect(speech.spoken.map(({ text }) => text)).toEqual([
    '观战小李进入观战区',
    '观战小王退出观战区'
  ]);
});

it('cancels queued speech and stops announcing immediately when the speaker is disabled', async () => {
  // Break caught: switching the speaker off leaves queued speech playing or continues reading later events.
  const speech = installSpeechSynthesis();
  const socket = new FakeGameSocket();
  renderGame(socket, snapshot({ players: players(1) }));
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '开启语音播报' }));
  speech.spoken.length = 0;

  await user.click(screen.getByRole('button', { name: '关闭语音播报' }));
  act(() => socket.fire('game.message.created', message()));

  expect(speech.cancelCount).toBe(1);
  expect(speech.spoken).toEqual([]);
});

it('cancels queued speech when leaving the table page', async () => {
  // Break caught: navigation removes the controls while the browser keeps reading an old table event.
  const speech = installSpeechSynthesis();
  const socket = new FakeGameSocket();
  const { unmount } = renderGame(socket, snapshot({ players: players(1) }));
  await userEvent.setup().click(await screen.findByRole('button', { name: '开启语音播报' }));

  unmount();

  expect(speech.cancelCount).toBe(1);
});

it('returns voice announcements to the default off state when entering another table', async () => {
  // Break caught: enabling one table silently carries voice playback into the next table after navigation.
  const speech = installSpeechSynthesis();
  const sockets: FakeGameSocket[] = [];
  const gameOne = snapshot({ id: 'game-1', name: '第一桌', players: players(1) });
  const gameTwo = snapshot({ id: 'game-2', name: '第二桌', players: [{ ...players(1)[0]!, id: 'player-game-2' }] });
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return Promise.resolve(jsonResponse(session()));
    if (url.endsWith('/api/games/game-1/snapshot')) return Promise.resolve(jsonResponse(gameOne));
    if (url.endsWith('/api/games/game-2/snapshot')) return Promise.resolve(jsonResponse(gameTwo));
    if (url.endsWith('/messages')) return Promise.resolve(jsonResponse({
      gameId: url.includes('game-2') ? 'game-2' : 'game-1',
      messages: []
    }));
    return Promise.resolve(jsonResponse({ code: 'NOT_FOUND' }, 404));
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
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '开启语音播报' }));
  speech.spoken.length = 0;

  await user.click(screen.getByRole('button', { name: '切换到第二桌' }));

  expect(await screen.findByRole('heading', { name: '第二桌' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '开启语音播报' })).toHaveAttribute('aria-pressed', 'false');
  expect(speech.cancelCount).toBe(1);
  act(() => sockets.at(-1)?.fire('game.message.created', message({
    id: '018f5d0d-43a8-7a7a-9b0b-0e8d9de76e03',
    gameId: 'game-2',
    text: '第二桌消息'
  })));
  expect(speech.spoken).toEqual([]);
});

it('keeps the speech draft and offers a Chinese retry message after send failure', async () => {
  // Break caught: a temporary send failure discards what the user typed or closes the only retry control.
  const socket = new FakeGameSocket();
  const { fetchMock } = renderGame(socket, snapshot({ players: players(1) }));
  await screen.findByTestId('round-table');
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input).endsWith('/api/games/game-1/messages') && init?.method === 'POST') {
      return jsonResponse({ code: 'INTERNAL_ERROR', message: '暂时发送失败' }, 500);
    }
    return original!(input, init);
  });
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: '发言' }));
  await user.type(screen.getByRole('textbox', { name: '发言内容' }), '等我一下');
  await user.click(screen.getByRole('button', { name: '发送' }));

  expect(await screen.findByText('服务暂时不可用，请稍后重试')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '发言内容' })).toHaveValue('等我一下');
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
});

it('accepts one strict realtime message for the current game and ignores duplicates or other games', async () => {
  // Break caught: socket retries duplicate speech, or malformed/cross-table payloads enter this table.
  const socket = new FakeGameSocket();
  renderGame(socket, snapshot({ players: players(1) }));
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: /^消息区/ }));

  act(() => {
    socket.fire('game.message.created', message());
    socket.fire('game.message.created', message());
    socket.fire('game.message.created', { ...message(), id: 'not-a-uuid' });
    socket.fire('game.message.created', {
      ...message({ id: '018f5d0d-43a8-7a7a-9b0b-0e8d9de76e02' }),
      gameId: 'other-game'
    });
  });

  expect(screen.getAllByText('马上到')).toHaveLength(1);
});

it('keeps the authoritative latest fifty messages in chronological order after a reconnect pull', () => {
  // Break caught: m1 is appended after m51 and becomes the visible latest speech after a reconnect.
  const makeWindowMessage = (index: number) => message({
    id: `018f5d0d-43a8-7a7a-9b0b-${String(index).padStart(12, '0')}`,
    text: `消息${index}`,
    createdAt: new Date(Date.UTC(2026, 7, 24, 9, 0, index)).toISOString()
  });
  const current = Array.from({ length: 50 }, (_, index) => makeWindowMessage(index + 1));
  const authoritative = Array.from({ length: 50 }, (_, index) => makeWindowMessage(index + 2));

  const merged = mergeGameMessageWindow(
    authoritative,
    current,
    new Set(current.map(({ id }) => id))
  );

  expect(merged).toHaveLength(50);
  expect(merged.map(({ text }) => text)).toEqual(
    Array.from({ length: 50 }, (_, index) => `消息${index + 2}`)
  );
  expect(merged.at(-1)?.text).toBe('消息51');
});

it('drops messages from before a pull while preserving only realtime messages that arrived during it', () => {
  // Break caught: an API restart returns an empty authoritative window but stale browser messages remain forever.
  const stale = message({ text: '重启前旧消息' });
  expect(mergeGameMessageWindow([], [stale], new Set([stale.id]))).toEqual([]);

  const sameTime = '2026-08-24T09:00:00.000Z';
  const authoritative = Array.from({ length: 50 }, (_, index) => message({
    id: `018f5d0d-43a8-7a7a-9b0b-${String(index + 100).padStart(12, '0')}`,
    text: `权威${index + 1}`,
    createdAt: sameTime
  }));
  const arrivedDuringPull = message({
    id: '018f5d0d-43a8-7a7a-9b0b-000000000999',
    text: '补拉期间的新消息',
    createdAt: sameTime
  });
  const merged = mergeGameMessageWindow(
    authoritative,
    [stale, arrivedDuringPull],
    new Set([stale.id])
  );

  expect(merged).toHaveLength(50);
  expect(merged.some(({ text }) => text === '重启前旧消息')).toBe(false);
  expect(merged.at(-1)?.text).toBe('补拉期间的新消息');
});

it('ignores delayed realtime speech when the loaded game is no longer active', async () => {
  // Break caught: a late socket event repopulates messages after settlement has cleared the arena.
  const socket = new FakeGameSocket();
  renderGame(socket, snapshot({ status: 'SETTLING', stoppedAt: '2026-08-24T09:00:00.000Z' }), 'ADMIN');
  const user = userEvent.setup();
  await screen.findByRole('link', { name: '继续结算' });

  act(() => { socket.fire('game.message.created', message({ text: '已经结束了' })); });
  await user.click(screen.getByRole('tab', { name: /^消息区/ }));

  expect(screen.queryByText('已经结束了')).not.toBeInTheDocument();
  expect(screen.getByText('本场还没有消息')).toBeInTheDocument();
});

it('shows the latest sender beside the arena even after that spectator goes offline', async () => {
  // Break caught: a valid current-game message exists but has no visible sender when presence changes first.
  const socket = new FakeGameSocket();
  renderGame(socket, snapshot({ players: players(1), spectators: [] }));
  await screen.findByTestId('round-table');

  act(() => {
    socket.fire('game.message.created', message({
      userId: 'offline-watcher',
      nickname: '刚离线的小王',
      avatarUrl: '/avatars/preset-12.webp',
      text: '我先走了'
    }));
  });

  const fallback = screen.getByTestId('arena-latest-message');
  expect(fallback).toHaveTextContent('刚离线的小王');
  expect(fallback).toHaveTextContent('我先走了');
  expect(screen.getByRole('img', { name: '刚离线的小王的头像' })).toBeInTheDocument();
});

it('puts player count, total buy-in, hand price, and timer in the compact table summary', async () => {
  // Break caught: vital table information is hidden in the ellipse instead of remaining readable above it.
  const socket = new FakeGameSocket();
  renderGame(socket, snapshot({
    handPrice: '300',
    players: [
      { ...players(2)[0]!, buyInAmount: '900' },
      { ...players(2)[1]!, buyInAmount: '1800' }
    ]
  }));

  const summary = await screen.findByTestId('game-table-summary');
  expect(summary).toHaveTextContent('玩家 2/12');
  expect(summary).toHaveTextContent('总买入 ¥2,700');
  expect(summary).toHaveTextContent('每手 ¥300');
  expect(summary).toHaveTextContent('01:00:00');
  expect(summary.compareDocumentPosition(screen.getByTestId('round-table')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('implements three linked tabs with roving focus and arrow-key selection', async () => {
  // Break caught: visual tabs lack programmatic panel ownership or cannot be operated without pointer input.
  const socket = new FakeGameSocket();
  renderGame(socket, snapshot({ players: players(1) }));
  const tableTab = await screen.findByRole('tab', { name: '竞技区' });
  const purchaseTab = screen.getByRole('tab', { name: /^购买记录/ });

  expect(tableTab).toHaveAttribute('aria-controls', 'game-panel-table');
  expect(tableTab).toHaveAttribute('tabindex', '0');
  expect(purchaseTab).toHaveAttribute('tabindex', '-1');
  expect(screen.getByRole('tabpanel', { name: '竞技区' })).toHaveAttribute('id', 'game-panel-table');

  tableTab.focus();
  await userEvent.setup().keyboard('{ArrowRight}');
  expect(purchaseTab).toHaveFocus();
  expect(purchaseTab).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tabpanel', { name: /^购买记录/ })).toHaveAttribute('id', 'game-panel-purchases');
  await userEvent.setup().keyboard('{Home}');
  expect(tableTab).toHaveFocus();
  await userEvent.setup().keyboard('{End}');
  expect(screen.getByRole('tab', { name: /^消息区/ })).toHaveFocus();
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

it('keeps the realtime warning hidden throughout the initial five-second connection grace period', async () => {
  // Break caught: the initial socket attempt immediately shows a warning before polling has actually taken over.
  vi.useFakeTimers();
  const socket = new FakeGameSocket();
  socket.autoConnect = false;
  renderGame(socket, snapshot({ players: players(1) }));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByTestId('round-table')).toBeInTheDocument();
  expect(screen.queryByRole('status', { name: '实时连接状态' })).not.toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
  expect(screen.queryByRole('status', { name: '实时连接状态' })).not.toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByRole('status', { name: '实时连接状态' }))
    .toHaveTextContent('实时连接中断，已启用每 10 秒定期同步');
});

it('lets the viewer dismiss the floating realtime fallback notice', async () => {
  // Break caught: the fallback warning permanently consumes vertical table space after the viewer has acknowledged it.
  vi.useFakeTimers();
  const socket = new FakeGameSocket();
  socket.autoConnect = false;
  renderGame(socket, snapshot({ players: players(1) }));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

  const notice = screen.getByRole('status', { name: '实时连接状态' });
  expect(notice).toBeVisible();
  act(() => within(notice).getByRole('button', { name: '关闭实时连接提示' }).click());
  expect(screen.queryByRole('status', { name: '实时连接状态' })).not.toBeInTheDocument();
});

it('starts exactly one polling refresh every ten seconds after the fallback activates', async () => {
  // Break caught: fallback refreshes immediately or duplicate disconnect callbacks create multiple polling intervals.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const socket = new FakeGameSocket();
  const { fetchMock } = renderGame(socket, snapshot({ players: players(1) }));
  await screen.findByTestId('round-table');
  await waitFor(() => expect(socket.joined).toHaveLength(1));
  fetchMock.mockClear();

  act(() => {
    socket.connected = false;
    socket.fire('disconnect');
    socket.fire('disconnect');
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(screen.getByText('实时连接中断，已启用每 10 秒定期同步')).toBeVisible();

  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/games/game-1/snapshot')))
    .toHaveLength(3);
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/games/game-1/messages')))
    .toHaveLength(3);
});

it('keeps an active polling fallback visible and refreshing after a reconnect disconnects without an acknowledgement', async () => {
  // Break caught: a second disconnect clears the active fallback before any room synchronization succeeds.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const socket = new FakeGameSocket();
  const { fetchMock } = renderGame(socket, snapshot({ players: players(1) }));
  await screen.findByTestId('round-table');
  await waitFor(() => expect(socket.joined).toHaveLength(1));

  act(() => {
    socket.connected = false;
    socket.fire('disconnect');
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(screen.getByRole('status', { name: '实时连接状态' })).toBeVisible();
  fetchMock.mockClear();

  socket.joinAcknowledgement = () => undefined;
  act(() => {
    socket.connected = true;
    socket.fire('connect');
    socket.connected = false;
    socket.fire('disconnect');
  });
  expect(screen.getByRole('status', { name: '实时连接状态' })).toBeVisible();

  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/games/game-1/snapshot')))
    .toHaveLength(3);
});

it('ignores a stale valid join acknowledgement after disconnecting from active polling', async () => {
  // Break caught: a prior room ACK stops an active polling fallback after its transport already disconnected.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const socket = new FakeGameSocket();
  const { fetchMock } = renderGame(socket, snapshot({ players: players(1) }));
  await screen.findByTestId('round-table');
  await waitFor(() => expect(socket.joined).toHaveLength(1));

  act(() => {
    socket.connected = false;
    socket.fire('disconnect');
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(screen.getByRole('status', { name: '实时连接状态' })).toBeVisible();
  fetchMock.mockClear();

  socket.deferJoinAcknowledgements = true;
  act(() => {
    socket.connected = true;
    socket.fire('connect');
    socket.connected = false;
    socket.fire('disconnect');
    socket.connected = true;
    socket.acknowledgeDeferredJoin();
  });
  expect(screen.getByRole('status', { name: '实时连接状态' })).toBeVisible();

  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/games/game-1/snapshot')))
    .toHaveLength(3);

  socket.deferJoinAcknowledgements = false;
  act(() => { socket.fire('connect'); });
  expect(screen.queryByRole('status', { name: '实时连接状态' })).not.toBeInTheDocument();
  fetchMock.mockClear();

  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/games/game-1/snapshot')))
    .toHaveLength(0);
});

it('ignores a stale valid join acknowledgement after server.error fails the current attempt', async () => {
  // Break caught: a failed join can still accept its ACK before its already-scheduled retry runs.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const socket = new FakeGameSocket();
  const { fetchMock } = renderGame(socket, snapshot({ players: players(1) }));
  await screen.findByTestId('round-table');
  await waitFor(() => expect(socket.joined).toHaveLength(1));

  act(() => {
    socket.connected = false;
    socket.fire('disconnect');
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(screen.getByRole('status', { name: '实时连接状态' })).toBeVisible();
  fetchMock.mockClear();

  socket.deferJoinAcknowledgements = true;
  act(() => {
    socket.connected = true;
    socket.fire('connect');
    socket.fire('server.error', { code: 'INTERNAL_ERROR' });
    socket.acknowledgeDeferredJoin();
  });
  expect(screen.getByRole('status', { name: '实时连接状态' })).toBeVisible();

  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(socket.joined).toHaveLength(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/games/game-1/snapshot')))
    .toHaveLength(3);

  act(() => { socket.acknowledgeLatestDeferredJoin(); });
  expect(screen.queryByRole('status', { name: '实时连接状态' })).not.toBeInTheDocument();
  fetchMock.mockClear();

  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/games/game-1/snapshot')))
    .toHaveLength(0);
});

it.each([
  ['error acknowledgement', () => ({ ok: false, code: 'FORBIDDEN' })],
  ['wrong-game acknowledgement', () => ({ ok: true, gameId: 'other-game', version: 1, snapshotSent: false })],
  ['timed-out acknowledgement', () => undefined]
])('does not clear active polling for a %s', async (_kind, acknowledgement) => {
  // Break caught: a transport reconnect treats a rejected, mismatched, or absent room ACK as synchronized.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const socket = new FakeGameSocket();
  const { fetchMock } = renderGame(socket, snapshot({ players: players(1) }));
  await screen.findByTestId('round-table');
  await waitFor(() => expect(socket.joined).toHaveLength(1));

  act(() => {
    socket.connected = false;
    socket.fire('disconnect');
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(screen.getByRole('status', { name: '实时连接状态' })).toBeVisible();
  fetchMock.mockClear();

  socket.joinAcknowledgement = () => acknowledgement();
  act(() => {
    socket.connected = true;
    socket.fire('connect');
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(screen.getByRole('status', { name: '实时连接状态' })).toBeVisible();

  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/games/game-1/snapshot')))
    .toHaveLength(3);
});

it('removes the polling warning and interval immediately after reconnecting', async () => {
  // Break caught: a recovered socket leaves the fallback warning or background polling active.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const socket = new FakeGameSocket();
  const { fetchMock } = renderGame(socket, snapshot({ players: players(1) }));
  await screen.findByTestId('round-table');
  await waitFor(() => expect(socket.joined).toHaveLength(1));

  act(() => {
    socket.connected = false;
    socket.fire('disconnect');
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(screen.getByText('实时连接中断，已启用每 10 秒定期同步')).toBeVisible();

  fetchMock.mockClear();
  act(() => {
    socket.connected = true;
    socket.fire('connect');
  });
  expect(screen.queryByText(/实时连接中断/)).not.toBeInTheDocument();

  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/games/game-1/snapshot')))
    .toHaveLength(0);
});

it('starts a new fallback grace period when a join acknowledgement and disconnect share one React batch', async () => {
  // Break caught: an ACK briefly clears polling, then a same-batch disconnect preserves a hidden prior interval.
  const socket = new FakeGameSocket();
  const { fetchMock } = renderGame(socket, snapshot({ players: players(1) }));
  await screen.findByTestId('round-table');
  await waitFor(() => expect(socket.joined).toHaveLength(1));

  // The initial ACK has stopped fallback before switching to a fully manual clock.
  vi.useFakeTimers();

  act(() => {
    socket.connected = false;
    socket.fire('disconnect');
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(screen.getByText('实时连接中断，已启用每 10 秒定期同步')).toBeVisible();
  fetchMock.mockClear();

  act(() => {
    socket.connected = true;
    socket.fire('connect');
    socket.connected = false;
    socket.fire('disconnect');
  });
  expect(screen.queryByText(/实时连接中断/)).not.toBeInTheDocument();

  await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
  expect(screen.queryByText(/实时连接中断/)).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByText('实时连接中断，已启用每 10 秒定期同步')).toBeVisible();

  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/games/game-1/snapshot')))
    .toHaveLength(1);
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
  expect(screen.queryByRole('status', { name: '实时连接状态' })).not.toBeInTheDocument();
  const initialSnapshots = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/snapshot')).length;

  // The fallback effect is installed after the failed ACK render, so allow its
  // five-second delay plus one scheduler turn instead of assuming timer epoch 0.
  await act(async () => { vi.advanceTimersByTime(5_100); });
  await waitFor(() => {
    expect(screen.getByRole('status', { name: '实时连接状态' })).toHaveTextContent('定期同步');
  });
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/snapshot'))).toHaveLength(initialSnapshots);

  socket.joinAcknowledgement = (command) => ({
    ok: true, gameId: command.gameId, version: command.knownVersion, snapshotSent: false
  });
  await act(async () => { vi.advanceTimersByTime(5_000); });
  expect(socket.joined.length).toBeGreaterThanOrEqual(2);
  expect(screen.queryByRole('status', { name: '实时连接状态' })).not.toBeInTheDocument();
});

it.each(['join acknowledgement', 'server error'] as const)(
  'exits a confirmed game when reconnect reports NOT_FOUND by %s',
  async (source) => {
    // Break caught: a client that missed the one-time deletion broadcast polls forever after the deleted room disappears.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = new FakeGameSocket();
    const { fetchMock } = renderGame(socket, snapshot({ players: players(1) }));
    await screen.findByTestId('round-table');
    await waitFor(() => expect(socket.joined).toHaveLength(1));

    act(() => {
      socket.connected = false;
      socket.fire('disconnect');
    });
    if (source === 'join acknowledgement') {
      socket.joinAcknowledgement = () => ({ ok: false, code: 'NOT_FOUND' });
      act(() => {
        socket.connected = true;
        socket.fire('connect');
      });
    } else {
      socket.joinAcknowledgement = () => undefined;
      act(() => {
        socket.connected = true;
        socket.fire('connect');
        socket.fire('server.error', { code: 'NOT_FOUND' });
      });
    }

    expect(screen.getByText('已返回首页')).toBeInTheDocument();
    expect(screen.getByTestId('deleted-navigation-state')).toHaveTextContent('{"notice":"该对局已由超级管理员删除"}');
    expect(socket.listenerCount()).toBe(0);
    fetchMock.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock).not.toHaveBeenCalled();
  }
);

it('does not claim an initially missing game was hard deleted', async () => {
  // Break caught: a plain bad URL is converted into the privileged hard-delete notice without evidence the game existed.
  const socket = new FakeGameSocket();
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session());
    if (url.endsWith('/api/games/missing-game/snapshot')) return jsonResponse({ code: 'NOT_FOUND' }, 404);
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));
  render(<AuthProvider><MemoryRouter initialEntries={['/games/missing-game']}><Routes>
    <Route path="/games/:id" element={<GamePage socketFactory={() => socket} />} />
    <Route path="/" element={<DeletedGameDestination />} />
  </Routes></MemoryRouter></AuthProvider>);

  expect(await screen.findByText('对局暂时无法加载，请稍后重试')).toBeInTheDocument();
  expect(screen.queryByText('已返回首页')).not.toBeInTheDocument();
  expect(socket.joined).toHaveLength(0);
  expect(socket.listenerCount()).toBe(0);
});

it('cleans fallback timeout and polling interval on unmount', async () => {
  // Break caught: navigation leaves fallback timers alive, causing refreshes after the page is gone.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const socket = new FakeGameSocket();
  const { fetchMock, unmount } = renderGame(socket, snapshot({ players: players(1) }));
  await screen.findByTestId('round-table');
  await waitFor(() => expect(socket.joined).toHaveLength(1));

  act(() => {
    socket.connected = false;
    socket.fire('disconnect');
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(screen.getByText('实时连接中断，已启用每 10 秒定期同步')).toBeVisible();
  fetchMock.mockClear();
  unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

  expect(fetchMock).not.toHaveBeenCalled();
  expect(socket.listenerCount()).toBe(0);
});

it('cleans the fallback timeout when unmounting during the connection grace period', async () => {
  // Break caught: leaving before polling begins still allows a stale fallback timer to refresh the removed page.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const socket = new FakeGameSocket();
  const { fetchMock, unmount } = renderGame(socket, snapshot({ players: players(1) }));
  await screen.findByTestId('round-table');
  await waitFor(() => expect(socket.joined).toHaveLength(1));

  act(() => {
    socket.connected = false;
    socket.fire('disconnect');
  });
  fetchMock.mockClear();
  unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

  expect(fetchMock).not.toHaveBeenCalled();
  expect(socket.listenerCount()).toBe(0);
  expect(screen.queryByText(/实时连接中断/)).not.toBeInTheDocument();
});

it('ignores malformed realtime events and reacts only to shared-contract payloads', async () => {
  // Break caught: an arbitrary Socket payload triggers a refresh or disconnect without passing the shared event schema.
  vi.useFakeTimers({ shouldAdvanceTime: true });
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
  socket.joinAcknowledgement = () => undefined;
  act(() => { socket.fire('server.error', { code: 'INTERNAL_ERROR' }); });
  expect(screen.queryByRole('status', { name: '实时连接状态' })).not.toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
  expect(screen.getByRole('status', { name: '实时连接状态' })).toBeInTheDocument();
});

it('redirects once for a matching shared deletion event, closes the end dialog, and stops page activity', async () => {
  // Break caught: malformed, duplicate, or another table's deletion redirects this page or leaves its fallback/listeners alive.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const socket = new FakeGameSocket();
  const { fetchMock } = renderGame(socket, snapshot({ players: players(1) }), 'ADMIN');
  await screen.findByTestId('round-table');
  await waitFor(() => expect(socket.listenerCount('game.updated')).toBe(1));

  act(() => {
    socket.connected = false;
    socket.fire('disconnect');
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(screen.getByRole('status', { name: '实时连接状态' })).toBeInTheDocument();
  await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole('button', { name: '结束对局' }));
  expect(screen.getByRole('dialog', { name: '确认结束对局' })).toBeInTheDocument();

  act(() => {
    socket.fire('game.deleted', { gameId: 'game-1', reason: 'SOFT_DELETED' });
    socket.fire('game.deleted', { gameId: 'other-game', reason: 'HARD_DELETED' });
    socket.fire('game.deleted', { gameId: 'game-1', reason: 'HARD_DELETED', extra: true });
  });
  expect(screen.queryByText('已返回首页')).not.toBeInTheDocument();

  fetchMock.mockClear();
  act(() => {
    socket.fire('game.deleted', { gameId: 'game-1', reason: 'HARD_DELETED' });
    socket.fire('game.deleted', { gameId: 'game-1', reason: 'HARD_DELETED' });
  });

  expect(screen.getByText('已返回首页')).toBeInTheDocument();
  expect(screen.getByTestId('deleted-navigation-type')).toHaveTextContent('REPLACE');
  expect(screen.getByTestId('deleted-navigation-state')).toHaveTextContent('{"notice":"该对局已由超级管理员删除"}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(socket.listenerCount()).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([
  ['购买弹层', async () => {
    await userEvent.setup().click(screen.getByRole('button', { name: '购买筹码' }));
    expect(screen.getByRole('dialog', { name: '购买筹码' })).toBeInTheDocument();
  }],
  ['调整弹窗', async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: /^购买记录/ }));
    await user.click(screen.getByRole('button', { name: '更正我的最后一笔购买' }));
    expect(screen.getByRole('dialog', { name: '更正最后一笔购买' })).toBeInTheDocument();
  }]
])('closes the open %s when the current game is deleted', async (_label, openDialog) => {
  // Break caught: a destructive event leaves stale buy-in controls mounted during the exit.
  const socket = new FakeGameSocket();
  renderGame(socket, snapshot({ players: players(1) }), 'USER');
  await screen.findByTestId('round-table');
  await openDialog();

  act(() => socket.fire('game.deleted', { gameId: 'game-1', reason: 'HARD_DELETED' }));

  expect(screen.getByText('已返回首页')).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('aborts an in-flight fallback load and end request before deletion navigation', async () => {
  // Break caught: late HTTP responses repopulate deleted game state or navigate onward to settlement.
  const backgroundSnapshot = deferred<Response>();
  const beginSettlement = deferred<Response>();
  let snapshotReads = 0;
  let backgroundSignal: AbortSignal | undefined;
  let endingSignal: AbortSignal | undefined;
  let beginCalls = 0;
  const socket = new FakeGameSocket();
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return Promise.resolve(jsonResponse(session('ADMIN')));
    if (url.endsWith('/api/games/game-1/snapshot')) {
      snapshotReads += 1;
      if (snapshotReads === 1) return Promise.resolve(jsonResponse(snapshot({ players: players(1) })));
      backgroundSignal = init?.signal ?? undefined;
      return backgroundSnapshot.promise;
    }
    if (url.endsWith('/api/games/game-1/begin-settlement')) {
      beginCalls += 1;
      endingSignal = init?.signal ?? undefined;
      return beginSettlement.promise;
    }
    return Promise.resolve(jsonResponse({ code: 'NOT_FOUND' }, 404));
  }));
  render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1']}><Routes>
    <Route path="/games/:id" element={<GamePage socketFactory={() => socket} />} />
    <Route path="/games/:id/settlement" element={<SettlementDestination />} />
    <Route path="/" element={<DeletedGameDestination />} />
  </Routes></MemoryRouter></AuthProvider>);
  const user = userEvent.setup();
  await screen.findByTestId('round-table');
  act(() => socket.fire('rake-settings.updated', { version: 2 }));
  await waitFor(() => expect(snapshotReads).toBe(2));
  await user.click(screen.getByRole('button', { name: '结束对局' }));
  await user.click(screen.getByRole('button', { name: '确认结束并进入结算' }));
  await waitFor(() => expect(beginCalls).toBe(1));

  act(() => socket.fire('game.deleted', { gameId: 'game-1', reason: 'HARD_DELETED' }));

  expect(backgroundSignal?.aborted).toBe(true);
  expect(endingSignal?.aborted).toBe(true);
  expect(screen.getByText('已返回首页')).toBeInTheDocument();
  await act(async () => {
    backgroundSnapshot.resolve(jsonResponse(snapshot({ version: 8, players: players(1) })));
    beginSettlement.resolve(jsonResponse(snapshot({ status: 'SETTLING', version: 9, players: players(1) })));
    await Promise.resolve();
  });
  expect(screen.queryByText('已进入结算页')).not.toBeInTheDocument();
  expect(screen.getAllByText('已返回首页')).toHaveLength(1);
});

it('aborts an in-flight purchase before deletion navigation and ignores its late success', async () => {
  // Break caught: a hard-deleted page lets a late buy-in success refresh the removed game after navigation.
  const purchase = deferred<Response>();
  let purchaseCalls = 0;
  let purchaseSignal: AbortSignal | undefined;
  let snapshotReads = 0;
  const exitOrder: string[] = [];
  const socket = new FakeGameSocket();
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return Promise.resolve(jsonResponse(session('USER')));
    if (url.endsWith('/api/games/game-1/snapshot')) { snapshotReads += 1; return Promise.resolve(jsonResponse(snapshot({ players: players(1) }))); }
    if (url.endsWith('/api/games/game-1/buyins')) {
      purchaseCalls += 1;
      purchaseSignal = init?.signal ?? undefined;
      return purchase.promise;
    }
    return Promise.resolve(jsonResponse({ code: 'NOT_FOUND' }, 404));
  }));
  render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1']}><Routes>
    <Route path="/games/:id" element={<GamePage socketFactory={() => socket} />} />
    <Route path="/games/:id/settlement" element={<SettlementDestination />} />
    <Route path="/" element={<DeletedGameDestination onRender={() => exitOrder.push('navigate')} />} />
  </Routes></MemoryRouter></AuthProvider>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '购买筹码' }));
  await user.click(screen.getByRole('button', { name: '确认购买 1 手' }));
  await waitFor(() => expect(purchaseCalls).toBe(1));
  expect(purchaseSignal).toBeDefined();
  purchaseSignal?.addEventListener('abort', () => exitOrder.push('abort'), { once: true });

  act(() => socket.fire('game.deleted', { gameId: 'game-1', reason: 'HARD_DELETED' }));

  expect(purchaseSignal?.aborted).toBe(true);
  expect(exitOrder.slice(0, 2)).toEqual(['abort', 'navigate']);
  expect(socket.listenerCount()).toBe(0);
  await act(async () => {
    purchase.resolve(jsonResponse({ eventId: 'buy-late', gameId: 'game-1', playerId: 'player-self', gameVersion: 2 }));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(snapshotReads).toBe(1);
  expect(screen.getByText('已返回首页')).toBeInTheDocument();
  expect(screen.queryByText('已进入结算页')).not.toBeInTheDocument();
});

it('aborts an in-flight adjustment before deletion navigation and ignores its late success', async () => {
  // Break caught: a hard-deleted page lets a late adjustment callback issue another snapshot read.
  const adjustment = deferred<Response>();
  let adjustmentCalls = 0;
  let adjustmentSignal: AbortSignal | undefined;
  let snapshotReads = 0;
  const exitOrder: string[] = [];
  const socket = new FakeGameSocket();
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return Promise.resolve(jsonResponse(session('USER')));
    if (url.endsWith('/api/games/game-1/snapshot')) { snapshotReads += 1; return Promise.resolve(jsonResponse(snapshot({ players: players(1) }))); }
    if (url.endsWith('/api/games/game-1/players/player-self/buyins/latest/adjust')) {
      adjustmentCalls += 1;
      adjustmentSignal = init?.signal ?? undefined;
      return adjustment.promise;
    }
    return Promise.resolve(jsonResponse({ code: 'NOT_FOUND' }, 404));
  }));
  render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1']}><Routes>
    <Route path="/games/:id" element={<GamePage socketFactory={() => socket} />} />
    <Route path="/games/:id/settlement" element={<SettlementDestination />} />
    <Route path="/" element={<DeletedGameDestination onRender={() => exitOrder.push('navigate')} />} />
  </Routes></MemoryRouter></AuthProvider>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: /^购买记录/ }));
  await user.click(screen.getByRole('button', { name: '更正我的最后一笔购买' }));
  await user.click(screen.getByRole('button', { name: '确认更正为 1 手' }));
  await waitFor(() => expect(adjustmentCalls).toBe(1));
  expect(adjustmentSignal).toBeDefined();
  adjustmentSignal?.addEventListener('abort', () => exitOrder.push('abort'), { once: true });

  act(() => socket.fire('game.deleted', { gameId: 'game-1', reason: 'HARD_DELETED' }));

  expect(adjustmentSignal?.aborted).toBe(true);
  expect(exitOrder.slice(0, 2)).toEqual(['abort', 'navigate']);
  expect(socket.listenerCount()).toBe(0);
  await act(async () => {
    adjustment.resolve(jsonResponse({ eventId: 'adjust-late', gameId: 'game-1', playerId: 'player-self', gameVersion: 2 }));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(snapshotReads).toBe(1);
  expect(screen.getByText('已返回首页')).toBeInTheDocument();
  expect(screen.queryByText('已进入结算页')).not.toBeInTheDocument();
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

it('aborts an in-flight purchase when the game route changes and ignores its late success', async () => {
  // Break caught: route cleanup leaves the old table mutation alive and lets its callback refresh the new table.
  const purchase = deferred<Response>();
  const sockets: FakeGameSocket[] = [];
  let purchaseSignal: AbortSignal | undefined;
  let gameOneReads = 0;
  const gameOne = snapshot({ id: 'game-1', name: '第一桌', players: players(1) });
  const gameTwo = snapshot({ id: 'game-2', name: '第二桌', players: [{ ...players(1)[0]!, id: 'player-game-2' }] });
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return Promise.resolve(jsonResponse(session()));
    if (url.endsWith('/api/games/game-1/snapshot')) { gameOneReads += 1; return Promise.resolve(jsonResponse(gameOne)); }
    if (url.endsWith('/api/games/game-2/snapshot')) return Promise.resolve(jsonResponse(gameTwo));
    if (url.endsWith('/api/games/game-1/buyins')) {
      purchaseSignal = init?.signal ?? undefined;
      return purchase.promise;
    }
    return Promise.resolve(jsonResponse({ code: 'NOT_FOUND' }, 404));
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
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '购买筹码' }));
  await user.click(screen.getByRole('button', { name: '确认购买 1 手' }));
  await waitFor(() => expect(purchaseSignal).toBeDefined());

  await user.click(screen.getByRole('button', { name: '切换到第二桌' }));

  expect(purchaseSignal?.aborted).toBe(true);
  expect(await screen.findByRole('heading', { name: '第二桌' })).toBeInTheDocument();
  expect(sockets[0]?.listenerCount()).toBe(0);
  await act(async () => {
    purchase.resolve(jsonResponse({ eventId: 'buy-late', gameId: 'game-1', playerId: 'player-self', gameVersion: 2 }));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(gameOneReads).toBe(1);
  expect(screen.getByRole('heading', { name: '第二桌' })).toBeInTheDocument();
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
