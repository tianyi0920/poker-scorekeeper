import { expect, test, type Frame, type WebSocketRoute } from '@playwright/test';
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

test('mobile live table waits for a real Socket.IO failure before polling, then recovers after the endpoint returns', async ({ browser }) => {
  const admin = await loginContext(browser, 'admin');
  let gameId: string | undefined;
  let blockSocketEndpoint = true;
  let blockedSocket: WebSocketRoute | undefined;
  let blockedSocketStartedAt: number | undefined;
  let routedSocketCount = 0;
  let forwardedSocketCount = 0;
  let mainFrameNavigationCount = 0;
  const snapshotRefreshes: string[] = [];
  const onResponse = (response: { request(): { method(): string }; url(): string }) => {
    const url = new URL(response.url());
    if (response.request().method() === 'GET' && url.pathname === `/api/games/${gameId}/snapshot`) {
      snapshotRefreshes.push(url.toString());
    }
  };
  const onFrameNavigated = (frame: Frame) => {
    if (frame === admin.page.mainFrame()) mainFrameNavigationCount += 1;
  };

  admin.page.on('response', onResponse);
  admin.page.on('framenavigated', onFrameNavigated);
  try {
    await admin.page.setViewportSize({ width: 390, height: 844 });
    const game = await createAndStartGame(admin.page, { handPrice: '300', rakeEnabled: true }, (createdGameId) => { gameId = createdGameId; });
    gameId = game.id;

    await expect(admin.page.getByRole('navigation', { name: '主导航' })).toHaveCount(0);
    await expect(admin.page.getByRole('status', { name: '实时连接状态' })).toHaveCount(0);
    await expect(admin.page.getByText('玩家 0/12')).toBeVisible();
    await expect(admin.page.getByTestId('round-table')).toHaveClass(/round-table--sparse/);

    await admin.page.routeWebSocket(/\/socket\.io\//, (socket) => {
      routedSocketCount += 1;
      if (blockSocketEndpoint) {
        blockedSocket = socket;
        blockedSocketStartedAt = Date.now();
        return;
      }
      forwardedSocketCount += 1;
      socket.connectToServer();
    });

    await admin.page.goto(`/games/${game.id}`);
    await expect.poll(() => routedSocketCount).toBe(1);
    await expect(admin.page.getByRole('status', { name: '实时连接状态' })).toHaveCount(0);
    await expect.poll(() => blockedSocketStartedAt === undefined).toBe(false);
    await admin.page.waitForTimeout(3_000);
    await expect(admin.page.getByRole('status', { name: '实时连接状态' })).toHaveCount(0);

    const warning = admin.page.getByRole('status', { name: '实时连接状态' });
    await expect(warning).toHaveText('实时连接中断，已启用每 10 秒定期同步');
    await expect(warning).toHaveCount(1);

    const refreshesBeforePolling = snapshotRefreshes.length;
    await expect.poll(() => snapshotRefreshes.length, { timeout: 12_000 })
      .toBeGreaterThanOrEqual(refreshesBeforePolling + 1);

    const roundTable = admin.page.getByTestId('round-table');
    const originalRoundTable = await roundTable.elementHandle();
    if (originalRoundTable === null) throw new Error('Live table did not render before recovery');
    const mainFrameNavigationCountBeforeRecovery = mainFrameNavigationCount;
    blockSocketEndpoint = false;
    if (blockedSocket === undefined) throw new Error('Socket.IO endpoint was not blocked');
    await blockedSocket.close();
    await expect.poll(() => routedSocketCount).toBeGreaterThanOrEqual(2);
    await expect.poll(() => forwardedSocketCount).toBeGreaterThanOrEqual(1);
    await expect.poll(() => mainFrameNavigationCount).toBe(mainFrameNavigationCountBeforeRecovery);
    expect(await originalRoundTable.evaluate((node) => node.isConnected)).toBeTruthy();
    await expect(admin.page).toHaveURL(new RegExp(`/games/${game.id}$`));
    await expect(admin.page.getByRole('heading', { name: game.name })).toBeVisible();
    await expect(roundTable).toBeVisible();
    await expect(admin.page.getByRole('status', { name: '实时连接状态' })).toHaveCount(0);
  } finally {
    admin.page.off('response', onResponse);
    admin.page.off('framenavigated', onFrameNavigated);
    await admin.context.close();
    if (gameId) await cleanupTaskGame(gameId);
  }
});
