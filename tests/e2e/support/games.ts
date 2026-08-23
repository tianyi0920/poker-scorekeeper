import { expect, type Page } from '@playwright/test';

export interface CreatedGame {
  id: string;
  name: string;
}

export async function createAndStartGame(
  page: Page,
  options: { handPrice: string; rakeEnabled: boolean },
  onGameCreated?: (gameId: string) => void
): Promise<CreatedGame> {
  const name = `Task18 完整流程 ${Date.now().toString(36)}`;
  await page.goto('/games/new');
  await expect(page.getByRole('button', { name: '创建并开启' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '创建草稿' })).toHaveCount(0);
  const startRequests: string[] = [];
  const recordStartRequest = (request: { method(): string; url(): string }) => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && /^\/api\/games\/[^/]+\/start$/.test(url.pathname)) {
      startRequests.push(url.pathname);
    }
  };
  page.on('request', recordStartRequest);
  await page.getByLabel('对局名称（选填）').fill(name);
  await page.getByLabel('每手金额').fill(options.handPrice);
  await page.getByLabel('启用抽成').setChecked(options.rakeEnabled);
  const createdResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'POST'
      && url.pathname === '/api/games'
      && response.status() === 201;
  });
  try {
    await page.getByRole('button', { name: '创建并开启' }).click();
    const created = await (await createdResponse).json() as { id: string; status: string };
    if (typeof created.id !== 'string' || created.id === '') throw new Error('Created game response has no id');
    const createdId = created.id;
    onGameCreated?.(createdId);
    expect(created.status).toBe('ACTIVE');
    await expect(page).toHaveURL(new RegExp(`/games/${createdId}$`));
    await expect(page.getByRole('heading', { name })).toBeVisible();
    expect(startRequests).toEqual([]);
    return { id: createdId, name };
  } finally {
    page.off('request', recordStartRequest);
  }
}

export async function buyHands(page: Page, gameId: string, hands: number): Promise<void> {
  await page.goto(`/games/${encodeURIComponent(gameId)}`);
  await page.getByRole('button', { name: '购买筹码' }).click();
  const quick = page.getByRole('button', { name: `购买 ${hands} 手` });
  if (await quick.count()) await quick.click();
  else await page.getByRole('spinbutton', { name: '购买手数' }).fill(String(hands));
  await page.getByRole('button', { name: `确认购买 ${hands} 手` }).click();
  await expect(page.getByRole('button', { name: '购买筹码' })).toBeVisible();
}

export async function adjustLatestBuy(page: Page, gameId: string, hands: number): Promise<void> {
  await page.goto(`/games/${encodeURIComponent(gameId)}`);
  await page.getByRole('tab', { name: /购买记录/ }).click();
  await page.getByRole('button', { name: '更正我的最后一笔购买' }).click();
  await page.getByRole('spinbutton', { name: '更正后手数' }).fill(String(hands));
  await page.getByRole('button', { name: `确认更正为 ${hands} 手` }).click();
  await expect(page.getByText(new RegExp(`更正 \\d+ → ${hands} 手`))).toBeVisible();
}
