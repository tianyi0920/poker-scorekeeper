import { expect, type Page } from '@playwright/test';
import { accounts } from './fixtures.js';

const gameParticipants = [accounts.admin, accounts['player-a'], accounts['player-b']];

function formatSignedMoney(value: string): string {
  const amount = BigInt(value);
  if (amount === 0n) return '¥0';
  return `${amount > 0n ? '+' : '−'}¥${(amount < 0n ? -amount : amount).toLocaleString('zh-CN')}`;
}

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
  await page.getByRole('button', { name: '进入核对' }).click();
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
  const aggregateResponse = await page.evaluate(async (selectedGameIds) => {
    const sessionResponse = await fetch('/api/auth/session', { credentials: 'same-origin' });
    const session = await sessionResponse.json() as { csrfToken?: string };
    const response = await fetch('/api/history/aggregate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': session.csrfToken ?? ''
      },
      credentials: 'same-origin',
      body: JSON.stringify({ gameIds: selectedGameIds })
    });
    return { status: response.status, body: await response.json() };
  }, gameIds);
  expect(aggregateResponse.status).toBe(200);
  const aggregate = aggregateResponse.body as {
    gameIds: string[];
    gameCount: number;
    playerCount: number;
    players: Array<{
      userId: string;
      nickname: string;
      finalAmount: string;
      games: Array<{ gameId: string }>;
    }>;
  };
  expect(aggregate.gameIds).toEqual(gameIds);
  expect(aggregate.gameCount).toBe(gameIds.length);
  expect(aggregate.playerCount).toBe(gameParticipants.length);
  const aggregateByUserId = new Map(aggregate.players.map((player) => [player.userId, player]));
  expect(aggregateByUserId.size).toBe(gameParticipants.length);
  const expectedAmounts = gameParticipants.map((account) => {
    const player = aggregateByUserId.get(account.id);
    expect(player, `actor-visible aggregate player ${account.id}`).toBeDefined();
    expect(player?.nickname).toBe(account.nickname);
    expect(player?.games.map((game) => game.gameId)).toEqual(gameIds);
    return [account, formatSignedMoney(player!.finalAmount)] as const;
  });
  expect(expectedAmounts.some(([, amount]) => amount.startsWith('+¥'))).toBe(true);
  expect(expectedAmounts.some(([, amount]) => amount.startsWith('−¥'))).toBe(true);
  expect(expectedAmounts.some(([, amount]) => amount === '¥0')).toBe(true);
  await page.goto(`/history/summary?games=${encodeURIComponent(gameIds.join(','))}`);
  await expect(page.getByRole('heading', { name: '全员汇总' })).toBeVisible();
  for (const [account, amount] of expectedAmounts) {
    await expect(page.getByRole('heading', { name: account.nickname })).toBeVisible();
    const card = page.locator('.aggregate-card').filter({ has: page.getByRole('heading', { name: account.nickname }) });
    await expect(card).toHaveCount(1);
    await expect(card.locator('.aggregate-actual strong')).toHaveText(amount);
  }
}
