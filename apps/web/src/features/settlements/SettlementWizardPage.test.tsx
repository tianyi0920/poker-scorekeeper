import { act, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
  renderWizard();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '下一步：费用分摊' }));
  expect(screen.getByLabelText('房费：天一，牌局盈亏 +¥1,500')).toBeChecked();
  expect(screen.getAllByText('老王').some((element) => element.parentElement?.textContent?.includes('−¥500'))).toBe(true);
  await user.click(screen.getByLabelText('其他费用：天一，牌局盈亏 +¥1,500'));
  expect(screen.getByLabelText('房费：天一，牌局盈亏 +¥1,500')).toBeChecked();
  expect(screen.getByLabelText('其他费用：天一，牌局盈亏 +¥1,500')).toBeChecked();
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
