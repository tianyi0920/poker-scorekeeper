import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../../auth/AuthProvider.js';
import { jsonResponse, session } from '../../test/app-fixtures.js';
import { SettlementDetailPage } from './SettlementDetailPage.js';

const player = { playerId: 'player-1', nickname: '天一', avatarKind: 'PRESET', avatarValue: 'avatar', seatNo: 1, buyIn: '100', cashOut: '100', rawProfit: '0', roomFeeShare: '0', otherFeeShare: '0', afterFeeProfit: '0', rakeEligible: false, rakeAmount: '0', finalAmount: '0' };
const detail = { game: { id: 'game-1', name: '网络结算', startedAt: '2026-08-18T10:00:00.000+08:00', stoppedAt: '2026-08-18T12:00:00.000+08:00', durationSeconds: 7200 }, completedAt: '2026-08-18T12:00:00.000+08:00', settledByNickname: '天一', otherFeeNote: '', immutable: true, totals: { buyIn: '100', cashOut: '100', roomFee: '0', otherFee: '0', rake: '0', final: '0' }, players: [player] };
const detailCacheKey = 'poker-scorekeeper:history-cache:v1:user-1:detail:game-1';

function renderDetail(response: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => (
    String(input).endsWith('/api/auth/session') ? jsonResponse(session()) : jsonResponse(response)
  )));
  return render(<AuthProvider><MemoryRouter initialEntries={['/history/game-1']}><Routes><Route path="/history/:id" element={<SettlementDetailPage />} /></Routes></MemoryRouter></AuthProvider>);
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
