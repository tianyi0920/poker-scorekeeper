import { expect, it } from 'vitest';
import { allPlayerAggregationSchema, historyListItemSchema, historyResponseSchema, settlementDetailSchema } from './history.js';

const item = { gameId: 'game-1', name: '牌局', completedAt: '2026-08-18T12:00:00.000+08:00', settledByNickname: '天一', myFinalAmount: '100' };
const player = {
  playerId: 'player-1', nickname: '天一', avatarKind: 'PRESET' as const, avatarValue: 'avatar', seatNo: 1,
  buyIn: '100', cashOut: '100', rawProfit: '0', roomFeeShare: '0', otherFeeShare: '0',
  afterFeeProfit: '0', rakeEligible: false, rakeAmount: '0', finalAmount: '0'
};
const detail = {
  totals: { buyIn: '100', cashOut: '100', roomFee: '0', otherFee: '0', rake: '0', final: '0' },
  players: [player],
  game: { id: 'game-1', name: '牌局', startedAt: '2026-08-18T10:00:00.000+08:00', stoppedAt: '2026-08-18T12:00:00.000+08:00', durationSeconds: 7200 },
  completedAt: '2026-08-18T12:00:00.000+08:00', settledByNickname: '天一', otherFeeNote: '', immutable: true as const
};
const aggregatePlayer = {
  userId: 'user-1', nickname: '天一', avatarUrl: 'avatar', gamesPlayed: 1, wins: 0, losses: 0,
  rawProfit: '0', roomFeeShare: '0', otherFeeShare: '0', afterFeeProfit: '0', rakeAmount: '0', finalAmount: '0',
  games: [{ gameId: 'game-1', gameName: '牌局', completedAt: '2026-08-18T12:00:00.000+08:00', finalAmount: '0' }]
};

it('rejects non-MoneyJson history money and malformed/oversized cursors while allowing base64url cursors', () => {
  expect(historyResponseSchema.safeParse({ items: [{ ...item, myFinalAmount: 'not-money' }], nextCursor: null }).success).toBe(false);
  expect(historyResponseSchema.safeParse({ items: [item], nextCursor: 'eyJjb21wbGV0ZWRBdCI6IjIwMjYtMDgtMThUMTI6MDA6MDAuMDAwKzA4OjAwIiwiaWQiOiJnYW1lLTEifQ' }).success).toBe(true);
  expect(historyResponseSchema.safeParse({ items: [item], nextCursor: '!bad' }).success).toBe(false);
  expect(historyResponseSchema.safeParse({ items: [item], nextCursor: 'a'.repeat(513) }).success).toBe(false);
});

it('accepts a nullable personal final amount without exposing a table total', () => {
  const personalResult = historyListItemSchema.parse({
    gameId: 'game-1', name: '测试', completedAt: '2026-08-18T12:00:00.000+08:00',
    settledByNickname: '管理员', myFinalAmount: '-1700'
  });
  expect(personalResult.myFinalAmount).toBe('-1700');
  const unseatedResult = historyListItemSchema.parse({
    gameId: 'game-1', name: '测试', completedAt: '2026-08-18T12:00:00.000+08:00',
    settledByNickname: '管理员', myFinalAmount: null
  });
  expect(unseatedResult.myFinalAmount).toBeNull();
});

it('rejects invalid MoneyJson values in settlement detail', () => {
  expect(settlementDetailSchema.safeParse({ ...detail, totals: { ...detail.totals, buyIn: 'not-money' } }).success).toBe(false);
  const aggregate = { gameIds: ['game-1'], gameCount: 1, playerCount: 1, players: [{ userId: 'user-1', nickname: '天一', avatarUrl: 'avatar', gamesPlayed: 1, wins: 1, losses: 0, rawProfit: 'not-money', roomFeeShare: '0', otherFeeShare: '0', afterFeeProfit: '0', rakeAmount: '0', finalAmount: '0', games: [] }] };
  expect(allPlayerAggregationSchema.safeParse(aggregate).success).toBe(false);
});

it('rejects duplicate history game ids at the duplicate item path', () => {
  const result = historyResponseSchema.safeParse({ items: [item, { ...item, name: '重复牌局' }], nextCursor: null });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: ['items', 1, 'gameId'], message: 'DUPLICATE_GAME_ID' })
  ]));
});

it('rejects duplicate settlement player ids while accepting empty and twelve-player breakdowns', () => {
  const duplicate = settlementDetailSchema.safeParse({ ...detail, players: [player, { ...player, seatNo: 2 }] });
  expect(duplicate.success).toBe(false);
  if (!duplicate.success) expect(duplicate.error.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: ['players', 1, 'playerId'], message: 'DUPLICATE_PLAYER_ID' })
  ]));
  expect(settlementDetailSchema.safeParse({ ...detail, players: [] }).success).toBe(true);
  expect(settlementDetailSchema.safeParse({
    ...detail,
    players: Array.from({ length: 12 }, (_, index) => ({ ...player, playerId: `player-${index + 1}`, seatNo: index + 1 }))
  }).success).toBe(true);
});

it('rejects duplicate aggregate user ids and per-player game ids at their identity paths', () => {
  const duplicatePlayers = allPlayerAggregationSchema.safeParse({
    gameIds: ['game-1'], gameCount: 1, playerCount: 2,
    players: [aggregatePlayer, { ...aggregatePlayer, nickname: '老王' }]
  });
  expect(duplicatePlayers.success).toBe(false);
  if (!duplicatePlayers.success) expect(duplicatePlayers.error.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: ['players', 1, 'userId'], message: 'DUPLICATE_USER_ID' })
  ]));

  const duplicateGames = allPlayerAggregationSchema.safeParse({
    gameIds: ['game-1'], gameCount: 1, playerCount: 1,
    players: [{ ...aggregatePlayer, gamesPlayed: 2, games: [aggregatePlayer.games[0], { ...aggregatePlayer.games[0], gameName: '重复牌局' }] }]
  });
  expect(duplicateGames.success).toBe(false);
  if (!duplicateGames.success) expect(duplicateGames.error.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: ['players', 0, 'games', 1, 'gameId'], message: 'DUPLICATE_GAME_ID' })
  ]));
});
