import { afterEach, expect, it } from 'vitest';
import { readCachedHistory, readCachedSettlementDetail, writeCachedHistory, writeCachedSettlementDetail } from './history-cache.js';

const item = { gameId: 'game-1', name: '缓存牌局', completedAt: '2026-08-18T12:00:00.000+08:00', settledByNickname: '天一', final: '9007199254740993000' };
const detail = { game: { id: 'game-1', name: '缓存牌局', startedAt: '2026-08-18T10:00:00.000+08:00', stoppedAt: '2026-08-18T12:00:00.000+08:00', durationSeconds: 7200 }, completedAt: '2026-08-18T12:00:00.000+08:00', settledByNickname: '天一', otherFeeNote: '', immutable: true as const, totals: { buyIn: '1000', cashOut: '1000', roomFee: '0', otherFee: '0', rake: '0', final: '0' }, players: [] };

afterEach(() => localStorage.clear());

it('restores versioned history and detail after a cold start without crossing user boundaries', () => {
  writeCachedHistory('user-1', { items: [item], nextCursor: null });
  writeCachedSettlementDetail('user-1', detail);
  expect(readCachedHistory('user-1')?.items[0]?.final).toBe('9007199254740993000');
  expect(readCachedSettlementDetail('user-1', 'game-1')?.game.name).toBe('缓存牌局');
  expect(readCachedHistory('user-2')).toBeNull();
  expect(readCachedSettlementDetail('user-2', 'game-1')).toBeNull();
});

it('fails closed for damaged cache records', () => {
  localStorage.setItem('poker-scorekeeper:history-cache:v1:user-1:list', '{broken');
  expect(readCachedHistory('user-1')).toBeNull();
});

it('rejects parseable invalid shapes, oversized lists, and mismatched detail ids without throwing', () => {
  const listKey = 'poker-scorekeeper:history-cache:v1:user-1:list'; const detailKey = 'poker-scorekeeper:history-cache:v1:user-1:detail:game-1';
  localStorage.setItem(listKey, JSON.stringify({ version: 1, cachedAt: 1, value: { items: [{ gameId: 7 }], nextCursor: null } }));
  expect(readCachedHistory('user-1')).toBeNull();
  localStorage.setItem(listKey, JSON.stringify({ version: 1, cachedAt: 1, value: { items: Array.from({ length: 101 }, () => item), nextCursor: null } }));
  expect(readCachedHistory('user-1')).toBeNull();
  localStorage.setItem(detailKey, JSON.stringify({ version: 1, cachedAt: 1, value: { ...detail, game: { ...detail.game, id: 'other-game' } } }));
  expect(readCachedSettlementDetail('user-1', 'game-1')).toBeNull();
});
