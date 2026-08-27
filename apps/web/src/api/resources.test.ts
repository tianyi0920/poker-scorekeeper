import { afterEach, expect, it, vi } from 'vitest';
import { currentGame, jsonResponse } from '../test/app-fixtures.js';
import { scorekeeperApi } from './resources.js';

const gameMessage = {
  id: '018f5d0d-43a8-7a7a-9b0b-0e8d9de76e01',
  gameId: 'game-1',
  userId: 'user-1',
  nickname: '西西',
  avatarUrl: '/avatars/preset-13.webp',
  text: '马上到',
  createdAt: '2026-08-24T09:00:00.000Z'
};

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

const gameWithoutCreator: Record<string, unknown> = { ...currentGame(1) };
delete gameWithoutCreator.createdById;

it.each([
  ['current games', () => scorekeeperApi.currentGames(), { games: [gameWithoutCreator] }],
  ['game creation', () => scorekeeperApi.createGame({ handPrice: '300', rakeEnabled: true }), gameWithoutCreator],
  ['begin settlement', () => scorekeeperApi.beginSettlement('game-1'), gameWithoutCreator]
])('rejects a snapshot response without its creator id for %s', async (_case, request, malformed) => {
  // Break caught: lifecycle resources accept snapshots that omit the owner used by client-side visibility rules.
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(malformed)));

  await expect(request()).rejects.toMatchObject({
    name: 'ApiError', status: 502, code: 'HTTP_ERROR', message: '服务器返回了无效结果'
  });
});

it('encodes current-game message paths before strictly rejecting non-canonical responses', async () => {
  // Break caught: a reserved game id alters the route or message responses bypass shared contracts.
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ gameId: 'game/1', messages: [] }))
    .mockResolvedValueOnce(jsonResponse({ ...gameMessage, gameId: 'game/1' }));
  vi.stubGlobal('fetch', fetchMock);

  await expect(scorekeeperApi.gameMessages('game/1')).rejects.toMatchObject({ status: 502 });
  await expect(scorekeeperApi.createGameMessage('game/1', { text: '马上到' }))
    .rejects.toMatchObject({ status: 502 });

  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    '/api/games/game%2F1/messages',
    expect.objectContaining({ credentials: 'same-origin' })
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    '/api/games/game%2F1/messages',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ text: '马上到' }),
      credentials: 'same-origin'
    })
  );
});

it.each([
  ['message list', () => scorekeeperApi.gameMessages('game-1'), {
    gameId: 'game-1', messages: [{ ...gameMessage, extra: true }]
  }],
  ['created message', () => scorekeeperApi.createGameMessage('game-1', { text: '马上到' }), {
    ...gameMessage, gameId: 'other-game'
  }]
])('rejects a malformed %s response as a controlled API error', async (_case, request, malformed) => {
  // Break caught: arbitrary or cross-game server fields are rendered as trusted speech.
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(malformed)));

  await expect(request()).rejects.toMatchObject({
    name: 'ApiError', status: 502, code: 'HTTP_ERROR', message: '服务器返回了无效结果'
  });
});

it('encodes managed-game pagination and hard-delete identifiers at the API boundary', async () => {
  // Break caught: opaque cursors or public IDs containing reserved URL characters alter the request path.
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }))
    .mockResolvedValueOnce(jsonResponse({ deletedGameId: 'game-1' }));
  vi.stubGlobal('fetch', fetchMock);

  await scorekeeperApi.managedGames(50, 'cursor/value');
  await scorekeeperApi.hardDeleteGame('game/1');

  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    '/api/games/manage?limit=50&cursor=cursor%2Fvalue',
    expect.objectContaining({ credentials: 'same-origin' })
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    '/api/games/game%2F1',
    expect.objectContaining({ method: 'DELETE', credentials: 'same-origin' })
  );
});

it.each([
  ['managed games', () => scorekeeperApi.managedGames(), {
    items: [{
      id: 'game-1', name: '测试局', status: 'ACTIVE',
      createdAt: '2026-08-24T10:00:00.000+08:00', startedAt: null,
      completedAt: null, playerCount: 13
    }],
    nextCursor: null
  }],
  ['hard deletion', () => scorekeeperApi.hardDeleteGame('game-1'), {
    deletedGameId: 'game-2', extra: true
  }]
])('rejects malformed %s responses as a controlled API error', async (_case, request, malformed) => {
  // Break caught: management resources trust malformed server payloads instead of shared contracts.
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(malformed)));

  await expect(request()).rejects.toMatchObject({
    name: 'ApiError', status: 502, code: 'HTTP_ERROR', message: '服务器返回了无效结果'
  });
});

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

it.each([
  ['preset catalog', () => scorekeeperApi.getPresetAvatars(), {
    presets: Array.from({ length: 12 }, (_, index) => {
      const id = index === 0 ? 'preset-01' : `preset-${index + 13}`;
      return { id, path: `/avatars/${id}.webp` };
    })
  }],
  ['preset save', () => scorekeeperApi.selectPresetAvatar({ presetId: 'preset-14' }), {
    avatarKind: 'PRESET', avatarValue: 'preset-01'
  }],
  ['administrator reset', () => scorekeeperApi.resetAvatar('user-1'), {
    avatarKind: 'UPLOAD', avatarValue: '../outside.webp', path: '../outside.webp'
  }]
])('rejects malformed avatar %s responses as a controlled API error', async (_case, request, malformed) => {
  // Break caught: hand-written avatar response types trust malformed catalog or mutation payloads.
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(malformed)));

  await expect(request()).rejects.toMatchObject({
    name: 'ApiError', status: 502, code: 'HTTP_ERROR', message: '服务器返回了无效结果'
  });
});
