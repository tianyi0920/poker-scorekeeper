import { expect, test } from '@playwright/test';
import {
  apiLogin,
  apiWrite,
  closeApiSessions,
  completeBalancedGameApi,
  prepareBalancedSettlement
} from './support/api.js';
import { loginContext } from './support/auth.js';
import { cleanupTaskGame, openTestDatabase } from './support/database.js';
import { performOwnedSettingsUpdate } from './support/settings-ownership.js';

function formatSignedMoney(value: string): string {
  const amount = BigInt(value);
  if (amount === 0n) return '¥0';
  return `${amount > 0n ? '+' : '−'}¥${(amount < 0n ? -amount : amount).toLocaleString('zh-CN')}`;
}

test('completed history is immutable, participant-visible in full, outsider-hidden, and all-player aggregated', async ({ browser }, testInfo) => {
  const admin = await apiLogin('admin');
  const playerA = await apiLogin('player-a');
  const playerB = await apiLogin('player-b');
  const outsider = await apiLogin('outsider');
  let gameId: string | undefined;
  let completedGameName: string | undefined;
  let participantFinalAmount: string | undefined;
  try {
    const completed = await completeBalancedGameApi(
      admin,
      playerA,
      playerB,
      '历史聚合',
      (createdGameId) => { gameId = createdGameId; }
    );
    gameId = completed.game.id;
    completedGameName = completed.game.name;
    const participantDetail = await playerA.context.get(`/api/history/${gameId}`);
    expect(participantDetail.status()).toBe(200);
    expect(await participantDetail.json()).toMatchObject({ immutable: true, players: expect.any(Array) });
    const participantHistory = await playerA.context.get('/api/history?limit=10');
    expect(participantHistory.status()).toBe(200);
    const participantHistoryBody = await participantHistory.json() as {
      items: Array<{ gameId: string; myFinalAmount: string | null }>;
    };
    const participantHistoryItem = participantHistoryBody.items.find((item) => item.gameId === gameId);
    expect(participantHistoryItem?.myFinalAmount).not.toBeNull();
    if (participantHistoryItem?.myFinalAmount === null || participantHistoryItem === undefined) {
      throw new Error('Completed participant history item must include a final amount');
    }
    participantFinalAmount = participantHistoryItem.myFinalAmount;
    const outsiderDetail = await outsider.context.get(`/api/history/${gameId}`);
    expect(outsiderDetail.status()).toBe(404);
    expect((await outsiderDetail.json()).code).toBe('HISTORY_SCOPE_DENIED');
    const aggregate = await apiWrite(playerA, 'post', '/api/history/aggregate', { gameIds: [gameId] });
    expect(aggregate.status()).toBe(200);
    expect(await aggregate.json()).toMatchObject({ gameCount: 1, playerCount: 3 });
    const duplicateFinalize = await apiWrite(admin, 'post', `/api/games/${gameId}/settlement-finalize`, completed.preview);
    expect(duplicateFinalize.status()).toBe(409);
  } catch (error) {
    if (gameId) await cleanupTaskGame(gameId);
    gameId = undefined;
    throw error;
  } finally {
    await closeApiSessions(admin, playerA, playerB, outsider);
  }

  if (!gameId || completedGameName === undefined || participantFinalAmount === undefined) {
    throw new Error('Completed Task18 game history was not captured');
  }

  const browserSession = await loginContext(browser, 'player-a');
  try {
    await browserSession.page.goto('/history');
    const resultRow = browserSession.page.locator('.result-row', { hasText: completedGameName });
    await expect(resultRow).toHaveCount(1);
    await expect(resultRow.locator('.result-amount')).toHaveText(
      formatSignedMoney(participantFinalAmount)
    );
    await browserSession.page.goto('/history/monthly');
    await expect(browserSession.page.getByRole('heading', { name: '月度排名' })).toBeVisible();
    await expect(browserSession.page.getByText('统计你参与的 1 场已结算牌局', { exact: true })).toBeVisible();
    const monthlyRow = browserSession.page.locator('.ranking-row', { hasText: playerA.user.nickname });
    await expect(monthlyRow).toHaveCount(1);
    await expect(monthlyRow.locator('.ranking-amount')).toHaveText(formatSignedMoney(participantFinalAmount));
    await browserSession.page.goto(`/history/${gameId}`);
    await expect(browserSession.page.getByLabel('历史结算明细')).toBeVisible();
    await expect(browserSession.page.getByRole('link', { name: '返回主页' })).toHaveAttribute('href', '/');
    await expect(browserSession.page.getByRole('heading', { name: '对局结算' })).toBeVisible();
    await expect(browserSession.page.getByText('德州计分', { exact: true })).toHaveCount(0);
    const bankReceivables = browserSession.page.getByRole('region', { name: '银行应收积分' });
    await expect(bankReceivables).toContainText(admin.user.nickname);
    await expect(bankReceivables.locator('.money--negative')).toHaveText(/−[\d,]+/);
    const bankPayables = browserSession.page.getByRole('region', { name: '银行应付积分' });
    await expect(bankPayables).toContainText(playerA.user.nickname);
    await expect(bankPayables.getByText('银行需付')).toBeVisible();
    await expect(bankPayables.locator('.money--positive')).toHaveText(/\+[\d,]+/);
    await expect(browserSession.page.getByRole('region', { name: '经费积分' })).toHaveCount(0);
    await expect(browserSession.page.getByRole('heading', { name: '个人明细' })).toBeVisible();
    await expect(browserSession.page.getByRole('button', { name: /永久锁定结算/ })).toHaveCount(0);
    await expect(browserSession.page.locator('input')).toHaveCount(0);
    const settlementOverflow = await browserSession.page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(settlementOverflow).toBeLessThanOrEqual(0);
    await testInfo.attach(`结算结果-${testInfo.project.name}`, {
      body: await browserSession.page.screenshot({ fullPage: true }),
      contentType: 'image/png'
    });
    await browserSession.page.goto(`/history/summary?games=${gameId}`);
    await expect(browserSession.page.getByRole('heading', { name: '全员汇总' })).toBeVisible();
    await expect(browserSession.page.locator('.aggregate-card')).toHaveCount(3);
    await expect(browserSession.page.getByRole('img', { name: /的当前头像$/ })).toHaveCount(3);
    await expect(browserSession.page.getByText('累计牌局盈亏')).toHaveCount(0);
    await expect(browserSession.page.getByRole('button', { name: /逐局明细$/ })).toHaveCount(3);
    const horizontalOverflow = await browserSession.page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(horizontalOverflow).toBeLessThanOrEqual(0);
    await testInfo.attach(`全员汇总-${testInfo.project.name}`, {
      body: await browserSession.page.screenshot({ fullPage: true }),
      contentType: 'image/png'
    });
  } finally {
    await browserSession.context.close();
    await cleanupTaskGame(gameId);
  }
});

test('a live rake rule change invalidates the old confirmation and the refreshed preview can finalize', async () => {
  const admin = await apiLogin('admin');
  const playerA = await apiLogin('player-a');
  const playerB = await apiLogin('player-b');
  const superAdmin = await apiLogin('super-admin');
  let gameId: string | undefined;
  try {
    const prepared = await prepareBalancedSettlement(
      admin,
      playerA,
      playerB,
      '实时抽成',
      (createdGameId) => { gameId = createdGameId; }
    );
    const settingsConnection = await openTestDatabase();
    const updated = await performOwnedSettingsUpdate(
      settingsConnection,
      superAdmin.user.id,
      (current) => ({ threshold: '0', bps: current.rake_bps === 2000 ? 1500 : 2000 }),
      (input) => apiWrite(superAdmin, 'patch', '/api/settings/rake', input)
    ).finally(() => settingsConnection.end());
    expect(updated.status()).toBe(200);

    const stale = await apiWrite(admin, 'post', `/api/games/${prepared.game.id}/settlement-finalize`, prepared.preview);
    expect(stale.status()).toBe(409);
    expect((await stale.json()).code).toBe('SETTINGS_VERSION_CONFLICT');
    const refreshedResponse = await apiWrite(
      admin,
      'post',
      `/api/games/${prepared.game.id}/settlement-preview`,
      prepared.payload
    );
    expect(refreshedResponse.status()).toBe(200);
    const refreshed = await refreshedResponse.json() as {
      draftVersion: number; settingsVersion: number; confirmationToken: string;
    };
    const finalized = await apiWrite(admin, 'post', `/api/games/${prepared.game.id}/settlement-finalize`, {
      draftVersion: refreshed.draftVersion,
      settingsVersion: refreshed.settingsVersion,
      confirmationToken: refreshed.confirmationToken
    });
    const finalBody = await finalized.json();
    expect(finalized.status(), JSON.stringify(finalBody)).toBe(201);
  } finally {
    await closeApiSessions(admin, playerA, playerB, superAdmin);
    if (gameId) await cleanupTaskGame(gameId);
  }
});
