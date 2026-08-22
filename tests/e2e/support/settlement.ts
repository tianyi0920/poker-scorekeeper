import { expect, type Page } from '@playwright/test';
import { accounts } from './fixtures.js';

const gameParticipants = [accounts.admin, accounts['player-a'], accounts['player-b']];

export async function settleBalancedGame(page: Page, gameId: string): Promise<void> {
  await page.goto(`/games/${encodeURIComponent(gameId)}`);
  await page.getByRole('button', { name: '结束对局' }).click();
  const begunResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'POST'
      && url.pathname === `/api/games/${encodeURIComponent(gameId)}/begin-settlement`
      && response.status() === 200;
  });
  await page.getByRole('button', { name: '确认结束并进入结算' }).click();
  await begunResponse;
  await expect(page).toHaveURL(new RegExp(`/games/${gameId}/settlement$`));

  await page.getByLabel(`${accounts.admin.nickname}的带走金额`).fill('600');
  await page.getByLabel(`${accounts['player-a'].nickname}的带走金额`).fill('1500');
  await page.getByLabel(`${accounts['player-b'].nickname}的带走金额`).fill('900');
  await expect.poll(async () => {
    const response = await page.context().request.get(`/api/games/${encodeURIComponent(gameId)}/settlement-draft`);
    if (!response.ok()) return false;
    return (await response.json() as { previewReady?: boolean }).previewReady === true;
  }, { timeout: 15_000 }).toBe(true);
  await page.reload();
  await expect(page.getByText('已平衡')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: '下一步：费用分摊' })).toBeEnabled();
  await page.getByRole('button', { name: '下一步：费用分摊' }).click();
  await page.getByRole('button', { name: '查看结算预览' }).click();
  await expect(page.getByLabel('结算预览')).toBeVisible();
  const previewActions = page.locator('.settlement-wizard .inline-actions');
  await expect(previewActions.getByRole('button')).toHaveCount(2);
  await expect(previewActions.getByRole('button', { name: '修改' })).toBeVisible();
  await expect(previewActions.getByRole('button', { name: '确认结算' })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新生成预览' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '确认永久结算' })).toHaveCount(0);
  await page.getByRole('button', { name: '确认结算' }).click();
  await expect(page.getByLabel('历史结算明细')).toBeVisible();
}

export async function expectSettlementDetail(page: Page, gameId: string): Promise<void> {
  await page.goto(`/history/${encodeURIComponent(gameId)}`);
  await expect(page.getByLabel('历史结算明细')).toBeVisible();
  for (const account of gameParticipants) {
    await expect(page.getByRole('heading', { name: account.nickname })).toBeVisible();
  }
}

export async function expectAllPlayerAggregate(page: Page, gameIds: string[]): Promise<void> {
  await page.goto(`/history/summary?games=${encodeURIComponent(gameIds.join(','))}`);
  await expect(page.getByRole('heading', { name: '全员汇总' })).toBeVisible();
  for (const account of gameParticipants) {
    await expect(page.getByRole('heading', { name: account.nickname })).toBeVisible();
  }
}
