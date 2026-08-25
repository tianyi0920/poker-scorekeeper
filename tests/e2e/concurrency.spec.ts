import { expect, test } from '@playwright/test';
import {
  apiBuyHands,
  apiLogin,
  apiLoginAccount,
  apiWrite,
  closeApiSessions,
  createStartedGame
} from './support/api.js';
import { cleanupTaskGame, expireTask18SettlementLease, openTestDatabase } from './support/database.js';
import { accounts } from './support/fixtures.js';
import { startFreshApi } from './support/restart.js';

test('five-table limit, one-player lock, idempotency, and correction chain hold through real HTTP', async () => {
  const admin = await apiLogin('admin');
  const playerA = await apiLogin('player-a');
  const games: string[] = [];
  try {
    const first = await createStartedGame(
      admin,
      '并发桌一',
      '300',
      (createdGameId) => games.push(createdGameId)
    );
    const second = await createStartedGame(
      admin,
      '并发桌二',
      '300',
      (createdGameId) => games.push(createdGameId)
    );
    for (const name of ['并发桌三', '并发桌四', '并发桌五']) {
      await createStartedGame(
        admin,
        name,
        '300',
        (createdGameId) => games.push(createdGameId)
      );
    }
    expect(games).toHaveLength(5);
    const database = await openTestDatabase();
    let gamesBefore: number;
    let auditsBefore: number;
    try {
      gamesBefore = Number((await database.query('SELECT COUNT(*) AS count FROM games'))[0].count);
      auditsBefore = Number((await database.query("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_type = 'GAME'"))[0].count);
    } finally {
      await database.end();
    }
    const rejectedCreate = await apiWrite(admin, 'post', '/api/games', {
      name: `Task18 第六桌 ${Date.now().toString(36)}`,
      handPrice: '300',
      rakeEnabled: true
    });
    expect(rejectedCreate.status()).toBe(409);
    expect((await rejectedCreate.json()).code).toBe('ACTIVE_GAME_LIMIT');
    const afterRejectedCreate = await openTestDatabase();
    try {
      expect(Number((await afterRejectedCreate.query('SELECT COUNT(*) AS count FROM games'))[0].count)).toBe(gamesBefore);
      expect(Number((await afterRejectedCreate.query("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_type = 'GAME'"))[0].count)).toBe(auditsBefore);
    } finally {
      await afterRejectedCreate.end();
    }

    const firstBuy = await apiBuyHands(playerA, first.id, 5, 'ledger-buy');
    expect(firstBuy.status()).toBe(201);
    const firstBody = await firstBuy.json() as { eventId: string; playerId: string; logicalBuyId: string };
    const replay = await apiBuyHands(playerA, first.id, 5, 'ledger-buy');
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toMatchObject({ eventId: firstBody.eventId, replayed: true });

    const otherTable = await apiBuyHands(playerA, second.id, 1, 'other-table');
    expect(otherTable.status()).toBe(409);
    expect((await otherTable.json()).code).toBe('USER_IN_ACTIVE_GAME');

    const adjustOne = await apiWrite(
      playerA,
      'post',
      `/api/games/${first.id}/players/${firstBody.playerId}/buyins/latest/adjust`,
      { newHands: 3, idempotencyKey: `${process.env.TASK18_RUN_ID}-adjust-one` }
    );
    expect(adjustOne.status()).toBe(201);
    expect(await adjustOne.json()).toMatchObject({ logicalBuyId: firstBody.logicalBuyId, newHands: 3, handsDelta: -2 });
    const adjustTwo = await apiWrite(
      playerA,
      'post',
      `/api/games/${first.id}/players/${firstBody.playerId}/buyins/latest/adjust`,
      { newHands: 4, idempotencyKey: `${process.env.TASK18_RUN_ID}-adjust-two` }
    );
    expect(adjustTwo.status()).toBe(201);
    expect(await adjustTwo.json()).toMatchObject({ logicalBuyId: firstBody.logicalBuyId, previousHands: 3, newHands: 4, handsDelta: 1 });
  } finally {
    await closeApiSessions(admin, playerA);
    for (const gameId of games.reverse()) await cleanupTaskGame(gameId);
  }
});

test('a second administrator is denied by an active lease and can take over only after expiry', async () => {
  const admin = await apiLogin('admin');
  const adminTwo = await apiLogin('admin-2');
  const player = await apiLogin('player-a');
  let gameId: string | undefined;
  try {
    const game = await createStartedGame(
      admin,
      '结算租约',
      '300',
      (createdGameId) => { gameId = createdGameId; }
    );
    expect((await apiBuyHands(player, game.id, 1, 'lease-buy')).status()).toBe(201);
    expect((await apiWrite(admin, 'post', `/api/games/${game.id}/begin-settlement`)).status()).toBe(200);
    const view = await adminTwo.context.get(`/api/games/${game.id}/settlement-draft`);
    expect(view.status()).toBe(200);
    expect(await view.json()).toMatchObject({ canEdit: false, canTakeOver: false });
    const early = await apiWrite(adminTwo, 'post', `/api/games/${game.id}/settlement-draft/takeover`);
    expect(early.status()).toBe(409);
    expect((await early.json()).code).toBe('DRAFT_LEASE_ACTIVE');
    await expireTask18SettlementLease(game.id);
    const taken = await apiWrite(adminTwo, 'post', `/api/games/${game.id}/settlement-draft/takeover`);
    const takenBody = await taken.json();
    expect(taken.status(), JSON.stringify(takenBody)).toBe(200);
    expect(takenBody).toMatchObject({ editorUserId: adminTwo.user.id, canEdit: true });
  } finally {
    await closeApiSessions(admin, adminTwo, player);
    if (gameId) await cleanupTaskGame(gameId);
  }
});

test('a fresh application process recovers the active game, player lock, buy-in, and settlement draft', async () => {
  const admin = await apiLogin('admin');
  const player = await apiLogin('player-a');
  let gameId: string | undefined;
  let fresh: Awaited<ReturnType<typeof startFreshApi>> | undefined;
  let recovered: Awaited<ReturnType<typeof apiLoginAccount>> | undefined;
  try {
    const game = await createStartedGame(
      admin,
      '重启恢复',
      '300',
      (createdGameId) => { gameId = createdGameId; }
    );
    expect((await apiBuyHands(player, game.id, 2, 'restart-buy')).status()).toBe(201);
    expect((await apiWrite(admin, 'post', `/api/games/${game.id}/begin-settlement`)).status()).toBe(200);

    fresh = await startFreshApi(3001);
    recovered = await apiLoginAccount(accounts.admin, fresh.baseURL);
    const snapshot = await recovered.context.get(`/api/games/${game.id}/snapshot`);
    expect(snapshot.status()).toBe(200);
    expect(await snapshot.json()).toMatchObject({
      id: game.id,
      status: 'SETTLING',
      players: [expect.objectContaining({ userId: accounts['player-a'].id, effectiveHands: 2 })]
    });
    const draft = await recovered.context.get(`/api/games/${game.id}/settlement-draft`);
    expect(draft.status()).toBe(200);
    expect(await draft.json()).toMatchObject({ gameId: game.id, version: expect.any(Number) });
  } finally {
    if (recovered) await closeApiSessions(recovered);
    if (fresh) await fresh.stop();
    await closeApiSessions(admin, player);
    if (gameId) await cleanupTaskGame(gameId);
  }
});
