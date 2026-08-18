import { expect, it } from 'vitest';
import { allPlayerAggregationSchema, historyResponseSchema, settlementDetailSchema } from './history.js';

const item = { gameId: 'game-1', name: '牌局', completedAt: '2026-08-18T12:00:00.000+08:00', settledByNickname: '天一', final: '100' };

it('rejects non-MoneyJson history money and malformed/oversized cursors while allowing base64url cursors', () => {
  expect(historyResponseSchema.safeParse({ items: [{ ...item, final: 'not-money' }], nextCursor: null }).success).toBe(false);
  expect(historyResponseSchema.safeParse({ items: [item], nextCursor: 'eyJjb21wbGV0ZWRBdCI6IjIwMjYtMDgtMThUMTI6MDA6MDAuMDAwKzA4OjAwIiwiaWQiOiJnYW1lLTEifQ' }).success).toBe(true);
  expect(historyResponseSchema.safeParse({ items: [item], nextCursor: '!bad' }).success).toBe(false);
  expect(historyResponseSchema.safeParse({ items: [item], nextCursor: 'a'.repeat(513) }).success).toBe(false);
});

it('rejects invalid MoneyJson values in settlement detail', () => {
  const detail = { totals: { buyIn: 'not-money', cashOut: '0', roomFee: '0', otherFee: '0', rake: '0', final: '0' }, players: [], game: { id: 'game-1', name: '牌局', startedAt: '2026-08-18T10:00:00.000+08:00', stoppedAt: '2026-08-18T12:00:00.000+08:00', durationSeconds: 7200 }, completedAt: '2026-08-18T12:00:00.000+08:00', settledByNickname: '天一', otherFeeNote: '', immutable: true };
  expect(settlementDetailSchema.safeParse(detail).success).toBe(false);
  const aggregate = { gameIds: ['game-1'], gameCount: 1, playerCount: 1, players: [{ userId: 'user-1', nickname: '天一', avatarUrl: 'avatar', gamesPlayed: 1, wins: 1, losses: 0, rawProfit: 'not-money', roomFeeShare: '0', otherFeeShare: '0', afterFeeProfit: '0', rakeAmount: '0', finalAmount: '0', games: [] }] };
  expect(allPlayerAggregationSchema.safeParse(aggregate).success).toBe(false);
});
