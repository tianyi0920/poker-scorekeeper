import { afterEach, expect, it, vi } from 'vitest';
import { jsonResponse } from '../test/app-fixtures.js';
import { scorekeeperApi } from './resources.js';

const payload = {
  cashOutByPlayerId: {}, roomFee: '0', roomPayerIds: [], otherFee: '0', otherFeeNote: '', otherPayerIds: []
};
const preview = {
  totals: { buyIn: '0', cashOut: '0', roomFee: '0', otherFee: '0', rake: '0', final: '0' },
  players: [], draftVersion: 1, settingsVersion: 1, previewReady: false,
  validationCode: 'CASH_OUTS_INCOMPLETE' as const, confirmationToken: null
};
const draft = {
  ...preview, gameId: 'game-1', version: 1, editorUserId: 'user-1', editorNickname: '天一',
  leaseExpiresAt: '2026-08-18T12:00:00.000+08:00', canEdit: true, canTakeOver: false, payload
};
const detail = {
  totals: preview.totals, players: [],
  game: { id: 'game-1', name: '牌局', startedAt: '2026-08-18T10:00:00.000+08:00', stoppedAt: '2026-08-18T12:00:00.000+08:00', durationSeconds: 7200 },
  completedAt: '2026-08-18T12:00:00.000+08:00', settledByNickname: '天一', otherFeeNote: '', immutable: true as const
};

afterEach(() => vi.unstubAllGlobals());

it.each([
  ['draft read', () => scorekeeperApi.settlementDraft('game-1'), { ...draft, totals: { ...draft.totals, buyIn: 'not-money' } }],
  ['draft save', () => scorekeeperApi.saveSettlementDraft('game-1', { version: 1, payload }), { ...draft, gameId: 'game-2' }],
  ['draft takeover', () => scorekeeperApi.takeOverSettlementDraft('game-1'), { ...draft, players: Array.from({ length: 13 }, () => ({ broken: true })) }],
  ['preview', () => scorekeeperApi.previewSettlement('game-1', payload), { ...preview, totals: { ...preview.totals, final: 'not-money' } }],
  ['finalization', () => scorekeeperApi.finalizeSettlement('game-1', { draftVersion: 1, settingsVersion: 1, confirmationToken: 'server-confirmation' }), { ...detail, game: { ...detail.game, id: 'game-2' } }]
])('rejects malformed live %s responses as a controlled API error', async (_case, request, malformed) => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(malformed)));
  await expect(request()).rejects.toMatchObject({
    name: 'ApiError', status: 502, code: 'HTTP_ERROR', message: '服务器返回了无效结果'
  });
});
