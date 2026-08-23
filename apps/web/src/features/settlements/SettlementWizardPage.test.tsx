import { act, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import type { GameSocketClient, GameSocketListener } from '../../api/game-socket.js';
import { AuthProvider } from '../../auth/AuthProvider.js';
import { jsonResponse, session } from '../../test/app-fixtures.js';
import { SettlementWizardPage } from './SettlementWizardPage.js';

class FakeGameSocket implements GameSocketClient {
  connected = false;
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  disconnectCalls = 0;
  private readonly listeners = new Map<string, Set<GameSocketListener>>();
  on(event: string, listener: GameSocketListener): this { const set = this.listeners.get(event) ?? new Set<GameSocketListener>(); set.add(listener); this.listeners.set(event, set); return this; }
  off(event: string, listener: GameSocketListener): this { this.listeners.get(event)?.delete(listener); return this; }
  emit(event: string, payload?: unknown): this { this.emitted.push({ event, payload }); return this; }
  connect(): this { this.connected = true; this.fire('connect'); return this; }
  disconnect(): this { this.disconnectCalls += 1; this.connected = false; return this; }
  fire(event: string, value?: unknown): void { for (const listener of this.listeners.get(event) ?? []) listener(value); }
  listenerCount(): number { return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0); }
}

const createUnusedSocket = () => new FakeGameSocket();

const players = [
  { playerId: 'player-1', nickname: '天一', avatarKind: 'PRESET', avatarValue: 'a', seatNo: 1, buyIn: '1000', cashOut: '2500', rawProfit: '1500', roomFeeShare: '190', otherFeeShare: '0', afterFeeProfit: '1310', rakeEligible: true, rakeAmount: '131', finalAmount: '1179' },
  { playerId: 'player-2', nickname: '老王', avatarKind: 'PRESET', avatarValue: 'b', seatNo: 2, buyIn: '1000', cashOut: '500', rawProfit: '-500', roomFeeShare: '190', otherFeeShare: '0', afterFeeProfit: '-690', rakeEligible: false, rakeAmount: '0', finalAmount: '-690' }
] as const;

function draft(overrides: Record<string, unknown> = {}) {
  return {
    gameId: 'game-1', version: 3, editorUserId: 'admin-1', editorNickname: '管理员', leaseExpiresAt: '2026-08-18T12:00:00.000+08:00', canEdit: true, canTakeOver: false,
    payload: { cashOutByPlayerId: { 'player-1': '2500', 'player-2': '500' }, roomFee: '380', roomPayerIds: ['player-1', 'player-2'], otherFee: '0', otherFeeNote: '', otherPayerIds: [] },
    totals: { buyIn: '2000', cashOut: '3000', roomFee: '380', otherFee: '0', rake: '131', final: '489' }, players, draftVersion: 3, settingsVersion: 2, previewReady: true, validationCode: null, confirmationToken: 'preview-token',
    ...overrides
  };
}

function previewResponse(overrides: Record<string, unknown> = {}) {
  const response = draft(overrides);
  return {
    totals: response.totals, players: response.players, draftVersion: response.draftVersion,
    settingsVersion: response.settingsVersion, previewReady: response.previewReady,
    validationCode: response.validationCode, confirmationToken: response.confirmationToken
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function RouteControl() { const navigate = useNavigate(); return <button onClick={() => navigate('/games/game-2/settlement')}>切换到第二局</button>; }

function DeletedGameDestination({ onRender }: { onRender?: () => void }) {
  const location = useLocation();
  onRender?.();
  return <div>
    已返回首页
    <span data-testid="deleted-navigation-type">{useNavigationType()}</span>
    <span data-testid="deleted-navigation-state">{JSON.stringify(location.state)}</span>
  </div>;
}

function renderDeletionWizard(socket: FakeGameSocket, onHomeRender?: () => void) {
  return render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1/settlement']}><Routes>
    <Route path="/games/:id/settlement" element={<SettlementWizardPage socketFactory={() => socket} />} />
    <Route path="/" element={<DeletedGameDestination onRender={onHomeRender} />} />
  </Routes></MemoryRouter></AuthProvider>);
}

function renderWizard(response = draft()) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('ADMIN'));
    if (url.endsWith('/api/games/game-1/settlement-draft')) return jsonResponse(response);
    if (url.endsWith('/api/games/game-1/settlement-preview')) return jsonResponse(previewResponse(response));
    if (url.endsWith('/api/games/game-1/settlement-finalize')) return jsonResponse(response);
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));
  return render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1/settlement']}><Routes><Route path="/games/:id/settlement" element={<SettlementWizardPage socketFactory={createUnusedSocket} />} /></Routes></MemoryRouter></AuthProvider>);
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); });

it('shows raw profit beside each completed cash-out and blocks an unbalanced next step', async () => {
  // Break caught: a client-side total lets an unbalanced table enter fee allocation.
  renderWizard(draft({ payload: { ...draft().payload, cashOutByPlayerId: { 'player-1': '1500', 'player-2': '300' } }, totals: { ...draft().totals, cashOut: '1800' }, previewReady: false, validationCode: 'TABLE_NOT_BALANCED' }));
  expect(await screen.findByText('牌局盈亏 +¥1,500')).toBeInTheDocument();
  expect(screen.getByText('牌局盈亏 −¥500')).toHaveClass('money--negative');
  expect(screen.getByText('还差 ¥200')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '下一步：费用分摊' })).toBeDisabled();
});

it('saves changed cash-outs after 400 ms and uses the server-balanced response as the gate', async () => {
  // Break caught: advancing based on a local sum skips the authoritative preview.
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    void init;
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('ADMIN'));
    if (url.endsWith('/api/games/game-1/settlement-draft')) return jsonResponse(draft());
    if (url.endsWith('/api/games/game-1/settlement-preview')) return jsonResponse(previewResponse());
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1/settlement']}><Routes><Route path="/games/:id/settlement" element={<SettlementWizardPage socketFactory={createUnusedSocket} />} /></Routes></MemoryRouter></AuthProvider>);
  const input = await screen.findByLabelText('天一的带走金额');
  vi.useFakeTimers();
  fireEvent.change(input, { target: { value: '2400' } });
  expect(screen.getByText('正在保存草稿…')).toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(399); });
  expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/settlement-draft') && (init as RequestInit | undefined)?.method === 'PUT')).toHaveLength(0);
  await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); });
  expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/settlement-draft') && (init as RequestInit | undefined)?.method === 'PUT')).toHaveLength(1);
  expect(screen.getByText('草稿已保存')).toBeInTheDocument();
});

it('replaces local state with the latest editor draft on a version conflict and cancels pending work on unmount', async () => {
  // Break caught: stale edits overwrite the current editor or a removed page saves after navigation.
  const latest = draft({ version: 8, editorNickname: '小李', canEdit: false, payload: { ...draft().payload, cashOutByPlayerId: { 'player-1': '2600', 'player-2': '400' } } });
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('ADMIN'));
    if (url.endsWith('/api/games/game-1/settlement-draft') && init?.method === 'PUT') return jsonResponse({ code: 'DRAFT_VERSION_CONFLICT', details: { latest } }, 409);
    if (url.endsWith('/api/games/game-1/settlement-draft')) return jsonResponse(draft());
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  const view = render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1/settlement']}><Routes><Route path="/games/:id/settlement" element={<SettlementWizardPage socketFactory={createUnusedSocket} />} /></Routes></MemoryRouter></AuthProvider>);
  const input = await screen.findByLabelText('天一的带走金额');
  vi.useFakeTimers();
  fireEvent.change(input, { target: { value: '2400' } });
  await act(async () => { vi.advanceTimersByTime(400); await Promise.resolve(); });
  expect(screen.getByText('草稿已由小李更新，已替换为服务器版本。')).toBeInTheDocument();
  expect(screen.getByLabelText('天一的带走金额')).toHaveValue('2600');
  fireEvent.change(screen.getByLabelText('天一的带走金额'), { target: { value: '2400' } });
  view.unmount();
  await act(async () => { vi.advanceTimersByTime(1_000); });
  expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/settlement-draft') && (init as RequestInit | undefined)?.method === 'PUT')).toHaveLength(1);
});

it('shows every candidate raw profit, preselects the server winner, and keeps room and other fee payers independent', async () => {
  // Break caught: fee allocation hides loss context or joins two independently persisted selections.
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); if (url.endsWith('/api/auth/session')) return jsonResponse(session('ADMIN'));
    if (url.endsWith('/api/games/game-1/settlement-draft')) return jsonResponse(draft()); void init; return jsonResponse({ code: 'NOT_FOUND' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1/settlement']}><Routes><Route path="/games/:id/settlement" element={<SettlementWizardPage socketFactory={createUnusedSocket} />} /></Routes></MemoryRouter></AuthProvider>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '下一步：费用分摊' }));
  expect(screen.getByLabelText('房费：天一，牌局盈亏 +¥1,500')).toBeChecked();
  expect(screen.getAllByText('老王').some((element) => element.parentElement?.textContent?.includes('−¥500'))).toBe(true);
  vi.useFakeTimers(); fireEvent.click(screen.getByLabelText('其他费用：天一，牌局盈亏 +¥1,500'));
  expect(screen.getByLabelText('房费：天一，牌局盈亏 +¥1,500')).toBeChecked();
  expect(screen.getByLabelText('其他费用：天一，牌局盈亏 +¥1,500')).toBeChecked();
  await act(async () => { vi.advanceTimersByTime(400); await Promise.resolve(); });
  const save = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/settlement-draft') && (init as RequestInit | undefined)?.method === 'PUT')!;
  expect(JSON.parse((save[1] as RequestInit).body as string).payload).toMatchObject({ roomPayerIds: ['player-1', 'player-2'], otherPayerIds: ['player-1'] });
});

it('requires a fresh preview after SETTINGS_VERSION_CONFLICT and disables writes offline', async () => {
  // Break caught: an obsolete confirmation token can permanently settle against changed rake settings.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('ADMIN'));
    if (url.endsWith('/api/games/game-1/settlement-draft')) return jsonResponse(draft());
    if (url.endsWith('/api/games/game-1/settlement-preview')) return jsonResponse(previewResponse());
    if (url.endsWith('/api/games/game-1/settlement-finalize')) return jsonResponse({ code: 'SETTINGS_VERSION_CONFLICT' }, 409);
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));
  render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1/settlement']}><Routes><Route path="/games/:id/settlement" element={<SettlementWizardPage socketFactory={createUnusedSocket} />} /></Routes></MemoryRouter></AuthProvider>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '下一步：费用分摊' }));
  await user.click(screen.getByRole('button', { name: '进入核对' }));
  expect(screen.getByLabelText('结算预览').querySelector('.settlement-breakdown-total')).toHaveTextContent('总抽成 ¥131');
  expect(screen.getAllByRole('button', { name: '确认结算' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: '修改' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: '重新生成预览' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '打开永久确认' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '确认结算' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect((await screen.findAllByText('抽成规则已变化，请重新核对')).length).toBeGreaterThan(0);
  expect(screen.queryByRole('button', { name: '确认结算' })).not.toBeInTheDocument();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  await act(async () => { window.dispatchEvent(new Event('offline')); });
  expect(screen.getByRole('button', { name: '进入核对' })).toBeDisabled();
});

it('ignores a deferred preview from revision A after revision B clears its confirmation material', async () => {
  // Break caught: an A preview resolves after B is edited and permits permanent settlement of A.
  const preview = deferred<Response>();
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return Promise.resolve(jsonResponse(session('ADMIN')));
    if (url.endsWith('/api/games/game-1/settlement-draft')) return Promise.resolve(jsonResponse(draft()));
    if (url.endsWith('/api/games/game-1/settlement-preview')) return preview.promise;
    if (url.endsWith('/api/games/game-1/settlement-finalize')) return Promise.resolve(jsonResponse(draft()));
    void init;
    return Promise.resolve(jsonResponse({ code: 'NOT_FOUND' }, 404));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1/settlement']}><Routes><Route path="/games/:id/settlement" element={<SettlementWizardPage socketFactory={createUnusedSocket} />} /></Routes></MemoryRouter></AuthProvider>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '下一步：费用分摊' }));
  await user.click(screen.getByRole('button', { name: '进入核对' }));
  fireEvent.change(screen.getByLabelText('房费（元）'), { target: { value: '500' } });
  await act(async () => { preview.resolve(jsonResponse(previewResponse())); await Promise.resolve(); });
  expect(screen.queryByRole('button', { name: '确认结算' })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/settlement-finalize'))).toHaveLength(0);
});

it('serializes A then B saves with the returned version and previews only saved B', async () => {
  // Break caught: two PUTs reuse version 3 and an A response overwrites the later B edit.
  const firstSave = deferred<Response>();
  const secondSave = deferred<Response>();
  let saveCalls = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return Promise.resolve(jsonResponse(session('ADMIN')));
    if (url.endsWith('/api/games/game-1/settlement-draft') && init?.method === 'PUT') return saveCalls++ === 0 ? firstSave.promise : secondSave.promise;
    if (url.endsWith('/api/games/game-1/settlement-draft')) return Promise.resolve(jsonResponse(draft()));
    if (url.endsWith('/api/games/game-1/settlement-preview')) return Promise.resolve(jsonResponse(previewResponse({ draftVersion: 5 })));
    return Promise.resolve(jsonResponse({ code: 'NOT_FOUND' }, 404));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1/settlement']}><Routes><Route path="/games/:id/settlement" element={<SettlementWizardPage socketFactory={createUnusedSocket} />} /></Routes></MemoryRouter></AuthProvider>);
  const input = await screen.findByLabelText('天一的带走金额');
  vi.useFakeTimers();
  fireEvent.change(input, { target: { value: '2400' } });
  await act(async () => { vi.advanceTimersByTime(400); await Promise.resolve(); });
  fireEvent.change(screen.getByLabelText('天一的带走金额'), { target: { value: '2300' } });
  await act(async () => { vi.advanceTimersByTime(400); await Promise.resolve(); });
  await act(async () => { firstSave.resolve(jsonResponse(draft({ version: 4, draftVersion: 4, payload: { ...draft().payload, cashOutByPlayerId: { 'player-1': '2400', 'player-2': '500' } } }))); await Promise.resolve(); });
  expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/settlement-draft') && (init as RequestInit | undefined)?.method === 'PUT')).toHaveLength(2);
  const secondBody = JSON.parse((fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/settlement-draft') && (init as RequestInit | undefined)?.method === 'PUT')[1]![1] as RequestInit).body as string);
  expect(secondBody).toMatchObject({ version: 4, payload: { cashOutByPlayerId: { 'player-1': '2300', 'player-2': '500' } } });
  await act(async () => { secondSave.resolve(jsonResponse(draft({ version: 5, draftVersion: 5, payload: { ...draft().payload, cashOutByPlayerId: { 'player-1': '2300', 'player-2': '500' } } }))); await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下一步：费用分摊' })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '进入核对' })); await Promise.resolve(); await Promise.resolve(); });
  const previewRequest = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/settlement-preview'))!;
  expect(JSON.parse((previewRequest[1] as RequestInit).body as string)).toMatchObject({ cashOutByPlayerId: { 'player-1': '2300', 'player-2': '500' } });
});

it('does not let a late game A save mutate game B after route switch', async () => {
  const slowSave = deferred<Response>();
  const gameB = draft({ gameId: 'game-2', version: 9, draftVersion: 9, payload: { ...draft().payload, cashOutByPlayerId: { 'player-1': '1000', 'player-2': '1000' } } });
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return Promise.resolve(jsonResponse(session('ADMIN')));
    if (url.endsWith('/api/games/game-1/settlement-draft') && init?.method === 'PUT') return slowSave.promise;
    if (url.endsWith('/api/games/game-1/settlement-draft')) return Promise.resolve(jsonResponse(draft()));
    if (url.endsWith('/api/games/game-2/settlement-draft')) return Promise.resolve(jsonResponse(gameB));
    return Promise.resolve(jsonResponse({ code: 'NOT_FOUND' }, 404));
  }));
  render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1/settlement']}><RouteControl /><Routes><Route path="/games/:id/settlement" element={<SettlementWizardPage socketFactory={createUnusedSocket} />} /></Routes></MemoryRouter></AuthProvider>);
  fireEvent.change(await screen.findByLabelText('天一的带走金额'), { target: { value: '2400' } });
  await new Promise((resolve) => window.setTimeout(resolve, 425));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '切换到第二局' })); await Promise.resolve(); await Promise.resolve(); });
  expect(await screen.findByLabelText('天一的带走金额')).toHaveValue('1000');
  await act(async () => { slowSave.resolve(jsonResponse(draft({ version: 4 }))); await Promise.resolve(); });
  expect(screen.getByLabelText('天一的带走金额')).toHaveValue('1000');
});

it('starts an independent B save after an in-flight A save is abandoned by a route switch', async () => {
  const saveA = deferred<Response>(); const saveB = deferred<Response>();
  const gameB = draft({ gameId: 'game-2', version: 9, draftVersion: 9, payload: { ...draft().payload, cashOutByPlayerId: { 'player-1': '1000', 'player-2': '1000' } } });
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); if (url.endsWith('/api/auth/session')) return Promise.resolve(jsonResponse(session('ADMIN')));
    if (url.endsWith('/api/games/game-1/settlement-draft') && init?.method === 'PUT') return saveA.promise;
    if (url.endsWith('/api/games/game-2/settlement-draft') && init?.method === 'PUT') return saveB.promise;
    if (url.endsWith('/api/games/game-1/settlement-draft')) return Promise.resolve(jsonResponse(draft()));
    if (url.endsWith('/api/games/game-2/settlement-draft')) return Promise.resolve(jsonResponse(gameB));
    return Promise.resolve(jsonResponse({ code: 'NOT_FOUND' }, 404));
  });
  vi.stubGlobal('fetch', fetchMock); render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1/settlement']}><RouteControl /><Routes><Route path="/games/:id/settlement" element={<SettlementWizardPage socketFactory={createUnusedSocket} />} /></Routes></MemoryRouter></AuthProvider>);
  const gameAInput = await screen.findByLabelText('天一的带走金额'); vi.useFakeTimers(); fireEvent.change(gameAInput, { target: { value: '2400' } }); await act(async () => { vi.advanceTimersByTime(400); await Promise.resolve(); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '切换到第二局' })); await Promise.resolve(); await Promise.resolve(); });
  fireEvent.change(screen.getByLabelText('天一的带走金额'), { target: { value: '1100' } }); await act(async () => { vi.advanceTimersByTime(400); await Promise.resolve(); });
  expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/games/game-2/settlement-draft') && (init as RequestInit | undefined)?.method === 'PUT')).toBe(true);
  await act(async () => { saveB.resolve(jsonResponse(gameB)); saveA.resolve(jsonResponse(draft({ version: 4 }))); await Promise.resolve(); });
});

it('retains a transiently failed payload for an explicit retry instead of losing the visible edit', async () => {
  let attempts = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); if (url.endsWith('/api/auth/session')) return jsonResponse(session('ADMIN'));
    if (url.endsWith('/api/games/game-1/settlement-draft') && init?.method === 'PUT') return attempts++ === 0 ? jsonResponse({ code: 'TEMPORARY' }, 500) : jsonResponse(draft({ version: 4, draftVersion: 4, payload: { ...draft().payload, cashOutByPlayerId: { 'player-1': '2400', 'player-2': '500' } } }));
    if (url.endsWith('/api/games/game-1/settlement-draft')) return jsonResponse(draft()); return jsonResponse({ code: 'NOT_FOUND' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock); render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1/settlement']}><Routes><Route path="/games/:id/settlement" element={<SettlementWizardPage socketFactory={createUnusedSocket} />} /></Routes></MemoryRouter></AuthProvider>);
  const retryInput = await screen.findByLabelText('天一的带走金额'); vi.useFakeTimers(); fireEvent.change(retryInput, { target: { value: '2400' } }); await act(async () => { vi.advanceTimersByTime(400); await Promise.resolve(); });
  expect(screen.getByRole('button', { name: '重试保存草稿' })).toBeInTheDocument(); expect(screen.getByLabelText('天一的带走金额')).toHaveValue('2400');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试保存草稿' })); await Promise.resolve(); await Promise.resolve(); });
  expect(attempts).toBe(2);
});

it('aborts initial loading and redirects once only for a matching deletion event', async () => {
  // Break caught: a settlement page accepts malformed/foreign events or lets a late initial draft revive a deleted session.
  const socket = new FakeGameSocket();
  const loading = deferred<Response>();
  let loadSignal: AbortSignal | undefined;
  const exitOrder: string[] = [];
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return Promise.resolve(jsonResponse(session('ADMIN')));
    if (url.endsWith('/api/games/game-1/settlement-draft')) { loadSignal = init?.signal ?? undefined; return loading.promise; }
    return Promise.resolve(jsonResponse({ code: 'NOT_FOUND' }, 404));
  }));
  renderDeletionWizard(socket, () => exitOrder.push('navigate'));
  await act(async () => { await Promise.resolve(); });
  expect(socket.emitted).toContainEqual({ event: 'game.join', payload: { gameId: 'game-1', knownVersion: 0 } });
  expect(loadSignal).toBeDefined();
  loadSignal?.addEventListener('abort', () => exitOrder.push('abort'), { once: true });

  act(() => {
    socket.fire('game.deleted', { gameId: 'game-2', reason: 'HARD_DELETED' });
    socket.fire('game.deleted', { gameId: 'game-1', reason: 'SOFT_DELETED' });
    socket.fire('game.deleted', { gameId: 'game-1', reason: 'HARD_DELETED', extra: true });
  });
  expect(screen.queryByText('已返回首页')).not.toBeInTheDocument();

  act(() => {
    socket.fire('game.deleted', { gameId: 'game-1', reason: 'HARD_DELETED' });
    socket.fire('game.deleted', { gameId: 'game-1', reason: 'HARD_DELETED' });
  });
  expect(loadSignal?.aborted).toBe(true);
  expect(exitOrder.slice(0, 2)).toEqual(['abort', 'navigate']);
  expect(screen.getByText('已返回首页')).toBeInTheDocument();
  expect(screen.getByTestId('deleted-navigation-type')).toHaveTextContent('REPLACE');
  expect(screen.getByTestId('deleted-navigation-state')).toHaveTextContent('{"notice":"该对局已由超级管理员删除"}');
  expect(socket.listenerCount()).toBe(0);
  expect(socket.disconnectCalls).toBe(1);

  await act(async () => { loading.resolve(jsonResponse(draft())); await Promise.resolve(); });
  expect(screen.queryByText('结算向导')).not.toBeInTheDocument();
});

it('invalidates pending draft state and aborts an in-flight save before redirecting', async () => {
  // Break caught: deletion leaves the debounce/session runner able to persist or display a stale draft.
  const socket = new FakeGameSocket();
  const saving = deferred<Response>();
  let saveSignal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return Promise.resolve(jsonResponse(session('ADMIN')));
    if (url.endsWith('/api/games/game-1/settlement-draft') && init?.method === 'PUT') { saveSignal = init.signal ?? undefined; return saving.promise; }
    if (url.endsWith('/api/games/game-1/settlement-draft')) return Promise.resolve(jsonResponse(draft()));
    return Promise.resolve(jsonResponse({ code: 'NOT_FOUND' }, 404));
  }));
  renderDeletionWizard(socket);
  const input = await screen.findByLabelText('天一的带走金额');
  vi.useFakeTimers();
  fireEvent.change(input, { target: { value: '2400' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(saveSignal).toBeDefined();

  act(() => socket.fire('game.deleted', { gameId: 'game-1', reason: 'HARD_DELETED' }));
  expect(saveSignal?.aborted).toBe(true);
  expect(screen.getByText('已返回首页')).toBeInTheDocument();
  await act(async () => { saving.resolve(jsonResponse(draft({ version: 4 }))); await Promise.resolve(); });
  expect(screen.queryByText('草稿已保存')).not.toBeInTheDocument();
});

it('clears an unsent pending edit and debounce timer before redirecting', async () => {
  // Break caught: a queued edit starts its PUT after the hard-deleted settlement page has already exited.
  const socket = new FakeGameSocket();
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return Promise.resolve(jsonResponse(session('ADMIN')));
    if (url.endsWith('/api/games/game-1/settlement-draft')) return Promise.resolve(jsonResponse(draft()));
    void init;
    return Promise.resolve(jsonResponse({ code: 'NOT_FOUND' }, 404));
  });
  vi.stubGlobal('fetch', fetchMock);
  renderDeletionWizard(socket);
  const input = await screen.findByLabelText('天一的带走金额');
  vi.useFakeTimers();
  fireEvent.change(input, { target: { value: '2400' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(399); });
  expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/settlement-draft') && (init as RequestInit | undefined)?.method === 'PUT')).toHaveLength(0);

  act(() => socket.fire('game.deleted', { gameId: 'game-1', reason: 'HARD_DELETED' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

  expect(screen.getByText('已返回首页')).toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/settlement-draft') && (init as RequestInit | undefined)?.method === 'PUT')).toHaveLength(0);
});

it('aborts an in-flight preview and clears its confirmation binding before redirecting', async () => {
  // Break caught: a late preview restores a token after the backing game was hard deleted.
  const socket = new FakeGameSocket();
  const preview = deferred<Response>();
  let previewSignal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return Promise.resolve(jsonResponse(session('ADMIN')));
    if (url.endsWith('/api/games/game-1/settlement-draft')) return Promise.resolve(jsonResponse(draft()));
    if (url.endsWith('/api/games/game-1/settlement-preview')) { previewSignal = init?.signal ?? undefined; return preview.promise; }
    return Promise.resolve(jsonResponse({ code: 'NOT_FOUND' }, 404));
  }));
  renderDeletionWizard(socket);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '下一步：费用分摊' }));
  await user.click(screen.getByRole('button', { name: '进入核对' }));
  expect(previewSignal).toBeDefined();

  act(() => socket.fire('game.deleted', { gameId: 'game-1', reason: 'HARD_DELETED' }));
  expect(previewSignal?.aborted).toBe(true);
  await act(async () => { preview.resolve(jsonResponse(previewResponse())); await Promise.resolve(); });
  expect(screen.getByText('已返回首页')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '确认结算' })).not.toBeInTheDocument();
});

it('aborts an in-flight finalization before deletion can race the history navigation', async () => {
  // Break caught: a late finalization response replaces the required deleted-game home notice with history.
  const socket = new FakeGameSocket();
  const finalizing = deferred<Response>();
  let finalizeSignal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return Promise.resolve(jsonResponse(session('ADMIN')));
    if (url.endsWith('/api/games/game-1/settlement-draft')) return Promise.resolve(jsonResponse(draft()));
    if (url.endsWith('/api/games/game-1/settlement-preview')) return Promise.resolve(jsonResponse(previewResponse()));
    if (url.endsWith('/api/games/game-1/settlement-finalize')) { finalizeSignal = init?.signal ?? undefined; return finalizing.promise; }
    return Promise.resolve(jsonResponse({ code: 'NOT_FOUND' }, 404));
  }));
  renderDeletionWizard(socket);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '下一步：费用分摊' }));
  await user.click(screen.getByRole('button', { name: '进入核对' }));
  await user.click(await screen.findByRole('button', { name: '确认结算' }));
  expect(finalizeSignal).toBeDefined();

  act(() => socket.fire('game.deleted', { gameId: 'game-1', reason: 'HARD_DELETED' }));
  expect(finalizeSignal?.aborted).toBe(true);
  await act(async () => { finalizing.resolve(jsonResponse(draft())); await Promise.resolve(); });
  expect(screen.getByText('已返回首页')).toBeInTheDocument();
  expect(screen.queryByText(/历史/)).not.toBeInTheDocument();
});

it('aborts an in-flight takeover and clears the read-only settlement state before redirecting', async () => {
  // Break caught: a late takeover response reactivates an editor session after hard deletion.
  const socket = new FakeGameSocket();
  const takingOver = deferred<Response>();
  let takeoverSignal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return Promise.resolve(jsonResponse(session('ADMIN')));
    if (url.endsWith('/api/games/game-1/settlement-draft/takeover')) { takeoverSignal = init?.signal ?? undefined; return takingOver.promise; }
    if (url.endsWith('/api/games/game-1/settlement-draft')) return Promise.resolve(jsonResponse(draft({ canEdit: false, canTakeOver: true, editorNickname: '老王' })));
    return Promise.resolve(jsonResponse({ code: 'NOT_FOUND' }, 404));
  }));
  renderDeletionWizard(socket);
  await userEvent.setup().click(await screen.findByRole('button', { name: '接管结算草稿' }));
  expect(takeoverSignal).toBeDefined();

  act(() => socket.fire('game.deleted', { gameId: 'game-1', reason: 'HARD_DELETED' }));
  expect(takeoverSignal?.aborted).toBe(true);
  await act(async () => { takingOver.resolve(jsonResponse(draft())); await Promise.resolve(); });
  expect(screen.getByText('已返回首页')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '接管结算草稿' })).not.toBeInTheDocument();
});
