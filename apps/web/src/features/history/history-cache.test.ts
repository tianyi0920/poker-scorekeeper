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

it('fails closed for invalid money/cursors and replaces a malformed detail index without crossing user keys', () => {
  const listKey = 'poker-scorekeeper:history-cache:v1:user-1:list'; const indexKey = 'poker-scorekeeper:history-cache:v1:user-1:detail-index';
  localStorage.setItem(listKey, JSON.stringify({ version: 1, cachedAt: 1, value: { items: [{ ...item, final: 'not-money' }], nextCursor: null } }));
  expect(readCachedHistory('user-1')).toBeNull();
  localStorage.setItem(listKey, JSON.stringify({ version: 1, cachedAt: 1, value: { items: [item], nextCursor: '!bad cursor' } }));
  expect(readCachedHistory('user-1')).toBeNull();
  localStorage.setItem(indexKey, JSON.stringify({ version: 1, cachedAt: 1, value: { version: 1, ids: ['BAD_ID', 'game-1', 'game-1'] } }));
  writeCachedSettlementDetail('user-1', detail);
  expect(localStorage.getItem(indexKey)).toContain('game-1');
  expect(localStorage.getItem('poker-scorekeeper:history-cache:v1:user-2:detail-index')).toBeNull();
});

it('refuses invalid values at the writer boundary without leaving persistent cache data', () => {
  const duplicateHistory = { items: [item, { ...item, name: '重复牌局' }], nextCursor: null };
  const duplicateDetail = { ...detail, players: [
    { playerId: 'player-1', nickname: '天一', avatarKind: 'PRESET', avatarValue: 'avatar', seatNo: 1, buyIn: '10', cashOut: '10', rawProfit: '0', roomFeeShare: '0', otherFeeShare: '0', afterFeeProfit: '0', rakeEligible: false, rakeAmount: '0', finalAmount: '0' },
    { playerId: 'player-1', nickname: '天一', avatarKind: 'PRESET', avatarValue: 'avatar', seatNo: 2, buyIn: '10', cashOut: '10', rawProfit: '0', roomFeeShare: '0', otherFeeShare: '0', afterFeeProfit: '0', rakeEligible: false, rakeAmount: '0', finalAmount: '0' }
  ] };

  expect(writeCachedHistory('user-1', duplicateHistory)).toBe(false);
  expect(writeCachedSettlementDetail('user-1', duplicateDetail)).toBe(false);
  expect(localStorage.length).toBe(0);
});
