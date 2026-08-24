import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactElement } from 'react';
import { AuthProvider } from '../../auth/AuthProvider.js';
import type { GameSocketClient, GameSocketListener } from '../../api/game-socket.js';
import { jsonResponse, session } from '../../test/app-fixtures.js';
import { readCachedHistory, readCachedSettlementDetail, writeCachedHistory, writeCachedSettlementDetail } from './history-cache.js';
import { SettlementDetailPage } from './SettlementDetailPage.js';

const player = { playerId: 'player-1', nickname: '天一', avatarKind: 'PRESET', avatarValue: 'avatar', seatNo: 1, buyIn: '100', cashOut: '100', rawProfit: '0', roomFeeShare: '0', otherFeeShare: '0', afterFeeProfit: '0', rakeEligible: false, rakeAmount: '0', finalAmount: '0' };
const detail = { game: { id: 'game-1', name: '网络结算', handPrice: '300', startedAt: '2026-08-18T10:00:00.000+08:00', stoppedAt: '2026-08-18T12:00:00.000+08:00', durationSeconds: 7200 }, completedAt: '2026-08-18T12:00:00.000+08:00', settledByNickname: '天一', otherFeeNote: '', immutable: true, totals: { buyIn: '100', cashOut: '100', roomFee: '0', otherFee: '0', rake: '0', final: '0' }, players: [player] };
const detailCacheKey = 'poker-scorekeeper:history-cache:v1:user-1:detail:game-1';
const history = { items: [{ gameId: 'game-1', name: '网络结算', completedAt: detail.completedAt, settledByNickname: '天一', myFinalAmount: '0' }], nextCursor: null };

class FakeGameSocket implements GameSocketClient {
  connected = false;
  private readonly listeners = new Map<string, Set<GameSocketListener>>();

  on(event: string, listener: GameSocketListener): this { const listeners = this.listeners.get(event) ?? new Set<GameSocketListener>(); listeners.add(listener); this.listeners.set(event, listeners); return this; }
  off(event: string, listener: GameSocketListener): this { this.listeners.get(event)?.delete(listener); return this; }
  emit(event: string, payload?: unknown, acknowledgement?: (value: unknown) => void): this { if (event === 'game.join') acknowledgement?.({ ok: true, gameId: 'game-1', version: 1, snapshotSent: false }); return this; }
  connect(): this { this.connected = true; this.fire('connect'); return this; }
  disconnect(): this { this.connected = false; return this; }
  fire(event: string, value?: unknown): void { for (const listener of this.listeners.get(event) ?? []) listener(value); }
}

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; }); return { promise, resolve, reject }; }

function warmHistoryCache() {
  writeCachedHistory('user-1', history);
  writeCachedSettlementDetail('user-1', detail);
}

function renderDetail(response: unknown | Promise<unknown>, status = 200, socketFactory?: () => GameSocketClient) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => (
    String(input).endsWith('/api/auth/session') ? jsonResponse(session()) : jsonResponse(await response, status)
  )));
  const DetailPage = SettlementDetailPage as unknown as (props: { socketFactory?: () => GameSocketClient }) => ReactElement;
  return render(<AuthProvider><MemoryRouter initialEntries={['/history/game-1']}><Routes><Route path="/history/:id" element={<DetailPage socketFactory={socketFactory} />} /><Route path="/history" element={<p>历史列表</p>} /></Routes></MemoryRouter></AuthProvider>);
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

it.each([
  ['invalid money', { ...detail, totals: { ...detail.totals, buyIn: 'not-money' } }],
  ['duplicate player ids', { ...detail, players: [player, { ...player, seatNo: 2 }] }],
  ['a mismatched game id', { ...detail, game: { ...detail.game, id: 'game-2' } }]
])('fails closed for live settlement detail with %s', async (_case, response) => {
  renderDetail(response);
  expect(await screen.findByText('该历史结算不存在，或你没有查看权限。')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重试加载' })).toBeInTheDocument();
  expect(screen.queryByText('网络结算')).not.toBeInTheDocument();
  expect(localStorage.getItem(detailCacheKey)).toBeNull();
});

it('renders a valid live detail and persists only the parsed value', async () => {
  renderDetail(detail);
  expect(await screen.findByRole('heading', { name: '网络结算' })).toBeInTheDocument();
  expect(screen.getByLabelText('历史结算明细').querySelector('.settlement-breakdown-total')).toHaveTextContent('总抽成 ¥0');
  expect(JSON.parse(localStorage.getItem(detailCacheKey) ?? 'null')?.value).toEqual(detail);
});

it.each([
  ['missing history', { code: 'NOT_FOUND' }, 404],
  ['revoked history access', { code: 'FORBIDDEN' }, 403]
])('evicts cached detail and history for %s', async (_case, response, status) => {
  warmHistoryCache();
  renderDetail(response, status);

  expect(await screen.findByRole('button', { name: '重试加载' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '网络结算' })).not.toBeInTheDocument();
  expect(readCachedSettlementDetail('user-1', 'game-1')).toBeNull();
  expect(readCachedHistory('user-1')?.items).toEqual([]);
});

it('keeps cached detail available for a network failure', async () => {
  const response = deferred<unknown>();
  warmHistoryCache();
  renderDetail(response.promise);
  await screen.findByRole('heading', { name: '网络结算' });
  await act(async () => { response.reject(new TypeError('offline')); await Promise.resolve(); });

  expect(await screen.findByText('当前离线，正在展示已缓存的历史结算。')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '网络结算' })).toBeInTheDocument();
  expect(readCachedSettlementDetail('user-1', 'game-1')?.game.name).toBe('网络结算');
  expect(readCachedHistory('user-1')?.items).toHaveLength(1);
});

it('exits an opened cached detail on deletion without letting a late read restore it', async () => {
  const response = deferred<unknown>();
  const socket = new FakeGameSocket();
  warmHistoryCache();
  renderDetail(response.promise, 200, () => socket);

  expect(await screen.findByRole('heading', { name: '网络结算' })).toBeInTheDocument();
  act(() => socket.fire('game.deleted', { gameId: 'game-1', reason: 'HARD_DELETED' }));
  expect(await screen.findByText('历史列表')).toBeInTheDocument();
  response.resolve(detail);
  await act(async () => { await Promise.resolve(); });

  expect(readCachedSettlementDetail('user-1', 'game-1')).toBeNull();
  expect(readCachedHistory('user-1')?.items).toEqual([]);
});
