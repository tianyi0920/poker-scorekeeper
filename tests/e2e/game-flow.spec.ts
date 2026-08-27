import { expect, test, type Frame, type WebSocketRoute } from '@playwright/test';
import { loginContext } from './support/auth.js';
import { adjustLatestBuy, buyHands, createAndStartGame } from './support/games.js';
import {
  beginSettlementFromGamePage,
  completeBalancedSettlement,
  expectAllPlayerAggregate,
  expectSettlementDetail,
  settleBalancedGame
} from './support/settlement.js';
import { cleanupTaskGame, expireTask18SettlementLease } from './support/database.js';
import { apiLogin, apiWrite, closeApiSessions } from './support/api.js';
import { accounts } from './support/fixtures.js';

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

test('a user creates, settles their own game, while another user is read-only and an admin can take over', async ({ browser }) => {
  const creator = await loginContext(browser, 'player-a');
  const viewer = await loginContext(browser, 'player-b');
  const admin = await loginContext(browser, 'admin');
  const viewerApi = await apiLogin('player-b');
  const adminApi = await apiLogin('admin');
  let settledGameId: string | undefined;
  let takeoverGameId: string | undefined;
  try {
    const created = await createAndStartGame(
      creator.page,
      { handPrice: '300', rakeEnabled: true, entry: 'home' },
      (createdGameId) => { settledGameId = createdGameId; }
    );
    settledGameId = created.id;
    const snapshot = await creator.page.context().request.get(`/api/games/${encodeURIComponent(created.id)}/snapshot`);
    expect(snapshot.status()).toBe(200);
    expect(await snapshot.json()).toMatchObject({ id: created.id, createdById: accounts['player-a'].id });

    await buyHands(creator.page, created.id, 5);
    await buyHands(viewer.page, created.id, 3);
    await buyHands(admin.page, created.id, 4);
    await adjustLatestBuy(creator.page, created.id, 3);

    await viewer.page.goto(`/games/${encodeURIComponent(created.id)}`);
    await expect(viewer.page.getByRole('heading', { name: created.name })).toBeVisible();
    await expect(viewer.page.getByRole('button', { name: '结束对局' })).toHaveCount(0);
    await expect(viewer.page.getByRole('link', { name: '继续结算' })).toHaveCount(0);

    await admin.page.goto(`/games/${encodeURIComponent(created.id)}`);
    await expect(admin.page.getByRole('heading', { name: created.name })).toBeVisible();
    await expect(admin.page.getByRole('button', { name: '结束对局' })).toBeVisible();

    const forbiddenBegin = await apiWrite(viewerApi, 'post', `/api/games/${encodeURIComponent(created.id)}/begin-settlement`);
    expect(forbiddenBegin.status()).toBe(403);
    expect((await forbiddenBegin.json()).code).toBe('FORBIDDEN');

    await beginSettlementFromGamePage(creator.page, created.id);
    await viewer.page.goto(`/games/${encodeURIComponent(created.id)}`);
    await expect(viewer.page).toHaveURL(new RegExp(`/games/${created.id}$`));
    await expect(viewer.page.getByRole('heading', { name: created.name })).toBeVisible();
    await expect(viewer.page.getByText('结算中', { exact: true })).toBeVisible();
    await expect(viewer.page.getByTestId('round-table')).toBeVisible();
    await expect(viewer.page.getByRole('link', { name: '继续结算' })).toHaveCount(0);

    await admin.page.goto(`/games/${encodeURIComponent(created.id)}`);
    await expect(admin.page.getByRole('heading', { name: created.name })).toBeVisible();
    await expect(admin.page.getByText('结算中', { exact: true })).toBeVisible();
    await expect(admin.page.getByRole('link', { name: '继续结算' }))
      .toHaveAttribute('href', `/games/${created.id}/settlement`);

    const draftResponse = await viewerApi.context.get(`/api/games/${encodeURIComponent(created.id)}/settlement-draft`);
    expect(draftResponse.status()).toBe(200);
    const draft = await draftResponse.json() as { version: number; payload: unknown };
    const forbiddenSave = await apiWrite(viewerApi, 'put', `/api/games/${encodeURIComponent(created.id)}/settlement-draft`, {
      version: draft.version,
      payload: draft.payload
    });
    expect(forbiddenSave.status()).toBe(403);
    expect((await forbiddenSave.json()).code).toBe('FORBIDDEN');
    const forbiddenFinalize = await apiWrite(viewerApi, 'post', `/api/games/${encodeURIComponent(created.id)}/settlement-finalize`, {
      draftVersion: draft.version,
      settingsVersion: 1,
      confirmationToken: 'not-authorized'
    });
    expect(forbiddenFinalize.status()).toBe(403);
    expect((await forbiddenFinalize.json()).code).toBe('FORBIDDEN');

    await completeBalancedSettlement(creator.page, created.id);
    await expectSettlementDetail(viewer.page, created.id);

    const takeover = await createAndStartGame(
      creator.page,
      { handPrice: '300', rakeEnabled: true },
      (createdGameId) => { takeoverGameId = createdGameId; }
    );
    takeoverGameId = takeover.id;
    await beginSettlementFromGamePage(creator.page, takeover.id);
    await expireTask18SettlementLease(takeover.id);
    const takenOver = await apiWrite(adminApi, 'post', `/api/games/${encodeURIComponent(takeover.id)}/settlement-draft/takeover`);
    expect(takenOver.status()).toBe(200);
    expect(await takenOver.json()).toMatchObject({ editorUserId: accounts.admin.id, canEdit: true });
  } finally {
    await Promise.all([
      creator.context.close(),
      viewer.context.close(),
      admin.context.close(),
      closeApiSessions(viewerApi, adminApi)
    ]);
    if (settledGameId) await cleanupTaskGame(settledGameId);
    if (takeoverGameId) await cleanupTaskGame(takeoverGameId);
  }
});

test('mobile live table waits for a real Socket.IO failure before polling, then recovers after the endpoint returns', async ({ browser }) => {
  const admin = await loginContext(browser, 'admin');
  let gameId: string | undefined;
  let blockSocketEndpoint = true;
  let dropForwardedSocketBeforeAck = false;
  let blockedSocket: WebSocketRoute | undefined;
  let blockedSocketStartedAt: number | undefined;
  let routedSocketCount = 0;
  let forwardedSocketCount = 0;
  let droppedBeforeAckSocketCount = 0;
  let droppedBeforeAckClose: Promise<void> | undefined;
  let mainFrameNavigationCount = 0;
  let primaryFailure: unknown;
  const routedSockets = new Set<WebSocketRoute>();
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
  const forward = (socket: WebSocketRoute): WebSocketRoute | undefined => socket.connectToServer();

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
      routedSockets.add(socket);
      if (blockSocketEndpoint) {
        blockedSocket = socket;
        blockedSocketStartedAt = Date.now();
        return;
      }
      const server = forward(socket);
      if (server !== undefined) {
        forwardedSocketCount += 1;
        if (dropForwardedSocketBeforeAck) {
          server.onMessage((message) => {
            if (!String(message).startsWith('43')) {
              socket.send(message);
              return;
            }
            droppedBeforeAckSocketCount += 1;
            droppedBeforeAckClose = socket.close();
          });
        }
      }
    });

    await admin.page.goto(`/games/${game.id}`);
    await expect.poll(() => routedSocketCount).toBe(1);
    await expect(admin.page.getByRole('status', { name: '实时连接状态' })).toHaveCount(0);
    await expect.poll(() => blockedSocketStartedAt === undefined).toBe(false);
    await admin.page.waitForTimeout(3_000);
    await expect(admin.page.getByRole('status', { name: '实时连接状态' })).toHaveCount(0);

    const warning = admin.page.getByRole('status', { name: '实时连接状态' });
    await expect(warning).toContainText('实时连接中断，已启用每 10 秒定期同步');
    await expect(warning).toHaveCount(1);

    const refreshesBeforePolling = snapshotRefreshes.length;
    await expect.poll(() => snapshotRefreshes.length, { timeout: 12_000 })
      .toBeGreaterThanOrEqual(refreshesBeforePolling + 1);

    const roundTable = admin.page.getByTestId('round-table');
    const originalRoundTable = await roundTable.elementHandle();
    if (originalRoundTable === null) throw new Error('Live table did not render before recovery');
    const mainFrameNavigationCountBeforeRecovery = mainFrameNavigationCount;
    blockSocketEndpoint = false;
    dropForwardedSocketBeforeAck = true;
    if (blockedSocket === undefined) throw new Error('Socket.IO endpoint was not blocked');
    await blockedSocket.close();
    await expect.poll(() => routedSocketCount).toBeGreaterThanOrEqual(2);
    await expect.poll(() => forwardedSocketCount).toBeGreaterThanOrEqual(1);
    await expect.poll(() => droppedBeforeAckSocketCount).toBeGreaterThanOrEqual(1);
    if (droppedBeforeAckClose === undefined) throw new Error('Forwarded Socket.IO connection was not closed before ACK');
    await droppedBeforeAckClose;
    await admin.page.waitForTimeout(500);
    expect(await warning.count()).toBe(1);

    const refreshesBeforeRejectedRecovery = snapshotRefreshes.length;
    await expect.poll(() => snapshotRefreshes.length, { timeout: 12_000 })
      .toBeGreaterThanOrEqual(refreshesBeforeRejectedRecovery + 1);

    dropForwardedSocketBeforeAck = false;
    await expect.poll(() => routedSocketCount, { timeout: 12_000 }).toBeGreaterThanOrEqual(3);
    await expect.poll(() => forwardedSocketCount, { timeout: 12_000 }).toBeGreaterThanOrEqual(2);
    await expect(warning).toHaveCount(0);
    await admin.page.waitForTimeout(5_500);
    await expect(warning).toHaveCount(0);
    await expect.poll(() => mainFrameNavigationCount).toBe(mainFrameNavigationCountBeforeRecovery);
    expect(await originalRoundTable.evaluate((node) => node.isConnected)).toBeTruthy();
    await expect(admin.page).toHaveURL(new RegExp(`/games/${game.id}$`));
    await expect(admin.page.getByRole('heading', { name: game.name })).toBeVisible();
    await expect(roundTable).toBeVisible();
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    const bestEffort = async (operation: () => void | Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    await Promise.all([
      bestEffort(() => admin.page.off('response', onResponse)),
      bestEffort(() => admin.page.off('framenavigated', onFrameNavigated))
    ]);
    const socketCloseResults = await Promise.allSettled(
      [...routedSockets].map(async (socket) => socket.close())
    );
    for (const result of socketCloseResults) {
      if (result.status === 'rejected') cleanupErrors.push(result.reason);
    }
    try {
      await bestEffort(() => admin.context.close());
    } finally {
      if (gameId) await bestEffort(() => cleanupTaskGame(gameId));
    }
    if (primaryFailure === undefined && cleanupErrors.length > 0) throw cleanupErrors[0];
  }
});
