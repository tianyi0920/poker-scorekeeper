import { act, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { AuthProvider } from '../../auth/AuthProvider.js';
import { jsonResponse, session } from '../../test/app-fixtures.js';
import { SettlementWizardPage } from './SettlementWizardPage.js';

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function RouteControl() { const navigate = useNavigate(); return <button onClick={() => navigate('/games/game-2/settlement')}>切换到第二局</button>; }

function renderWizard(response = draft()) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) return jsonResponse(session('ADMIN'));
    if (url.endsWith('/api/games/game-1/settlement-draft')) return jsonResponse(response);
    if (url.endsWith('/api/games/game-1/settlement-preview')) return jsonResponse(response);
    if (url.endsWith('/api/games/game-1/settlement-finalize')) return jsonResponse(response);
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));
  return render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1/settlement']}><Routes><Route path="/games/:id/settlement" element={<SettlementWizardPage />} /></Routes></MemoryRouter></AuthProvider>);
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); });

it('shows raw profit beside each completed cash-out and blocks an unbalanced next step', async () => {
  // Break caught: a client-side total lets an unbalanced table enter fee allocation.
  renderWizard(draft({ payload: { ...draft().payload, cashOutByPlayerId: { 'player-1': '1500', 'player-2': '300' } }, totals: { ...draft().totals, cashOut: '1800' }, previewReady: false, validationCode: 'TABLE_NOT_BALANCED' }));
  expect(await screen.findByText('牌局盈亏 +¥1,500')).toBeInTheDocument();
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
    if (url.endsWith('/api/games/game-1/settlement-preview')) return jsonResponse(draft());
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1/settlement']}><Routes><Route path="/games/:id/settlement" element={<SettlementWizardPage />} /></Routes></MemoryRouter></AuthProvider>);
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
  const view = render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1/settlement']}><Routes><Route path="/games/:id/settlement" element={<SettlementWizardPage />} /></Routes></MemoryRouter></AuthProvider>);
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
  render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1/settlement']}><Routes><Route path="/games/:id/settlement" element={<SettlementWizardPage />} /></Routes></MemoryRouter></AuthProvider>);
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
    if (url.endsWith('/api/games/game-1/settlement-preview')) return jsonResponse(draft());
    if (url.endsWith('/api/games/game-1/settlement-finalize')) return jsonResponse({ code: 'SETTINGS_VERSION_CONFLICT' }, 409);
    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }));
  render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1/settlement']}><Routes><Route path="/games/:id/settlement" element={<SettlementWizardPage />} /></Routes></MemoryRouter></AuthProvider>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '下一步：费用分摊' }));
  await user.click(screen.getByRole('button', { name: '查看结算预览' }));
  await user.click(screen.getByRole('button', { name: '打开永久确认' }));
  await user.click(screen.getByRole('button', { name: '确认并永久锁定结算' }));
  expect((await screen.findAllByText('抽成规则已变化，请重新核对')).length).toBeGreaterThan(0);
  expect(screen.queryByRole('button', { name: '确认并永久锁定结算' })).not.toBeInTheDocument();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  await act(async () => { window.dispatchEvent(new Event('offline')); });
  expect(screen.getByRole('button', { name: '查看结算预览' })).toBeDisabled();
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
  render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1/settlement']}><Routes><Route path="/games/:id/settlement" element={<SettlementWizardPage />} /></Routes></MemoryRouter></AuthProvider>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '下一步：费用分摊' }));
  await user.click(screen.getByRole('button', { name: '查看结算预览' }));
  fireEvent.change(screen.getByLabelText('房费（元）'), { target: { value: '500' } });
  await act(async () => { preview.resolve(jsonResponse(draft())); await Promise.resolve(); });
  expect(screen.queryByRole('button', { name: '打开永久确认' })).not.toBeInTheDocument();
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
    if (url.endsWith('/api/games/game-1/settlement-preview')) return Promise.resolve(jsonResponse(draft({ version: 5, draftVersion: 5 })));
    return Promise.resolve(jsonResponse({ code: 'NOT_FOUND' }, 404));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1/settlement']}><Routes><Route path="/games/:id/settlement" element={<SettlementWizardPage />} /></Routes></MemoryRouter></AuthProvider>);
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
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '查看结算预览' })); await Promise.resolve(); await Promise.resolve(); });
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
  render(<AuthProvider><MemoryRouter initialEntries={['/games/game-1/settlement']}><RouteControl /><Routes><Route path="/games/:id/settlement" element={<SettlementWizardPage />} /></Routes></MemoryRouter></AuthProvider>);
  fireEvent.change(await screen.findByLabelText('天一的带走金额'), { target: { value: '2400' } });
  await new Promise((resolve) => window.setTimeout(resolve, 425));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '切换到第二局' })); await Promise.resolve(); await Promise.resolve(); });
  expect(await screen.findByLabelText('天一的带走金额')).toHaveValue('1000');
  await act(async () => { slowSave.resolve(jsonResponse(draft({ version: 4 }))); await Promise.resolve(); });
  expect(screen.getByLabelText('天一的带走金额')).toHaveValue('1000');
});
