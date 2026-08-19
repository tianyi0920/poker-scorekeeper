import { test } from '@playwright/test';
import { loginContext } from './support/auth.js';
import { adjustLatestBuy, buyHands, createAndStartGame } from './support/games.js';
import {
  expectAllPlayerAggregate,
  expectSettlementDetail,
  settleBalancedGame
} from './support/settlement.js';
import { cleanupTaskGame } from './support/database.js';

test('admin creates, three players buy, settle, and aggregate the table', async ({ browser }) => {
  const admin = await loginContext(browser, 'admin');
  const playerA = await loginContext(browser, 'player-a');
  const playerB = await loginContext(browser, 'player-b');
  let gameId: string | undefined;
  try {
    const game = await createAndStartGame(
      admin.page,
      { handPrice: '300', rakeEnabled: true },
      (createdGameId) => { gameId = createdGameId; }
    );
    gameId = game.id;
    await buyHands(playerA.page, game.id, 5);
    await buyHands(playerB.page, game.id, 3);
    await adjustLatestBuy(playerA.page, game.id, 3);
    await buyHands(admin.page, game.id, 4);
    await settleBalancedGame(admin.page, game.id);
    await expectSettlementDetail(playerA.page, game.id);
    await expectAllPlayerAggregate(playerA.page, [game.id]);
  } finally {
    await Promise.all([admin.context.close(), playerA.context.close(), playerB.context.close()]);
    if (gameId) await cleanupTaskGame(gameId);
  }
});
