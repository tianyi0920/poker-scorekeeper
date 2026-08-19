import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { fixtureAccount, type FixtureRole } from './fixtures.js';

export interface LoggedInContext {
  context: BrowserContext;
  page: Page;
}

export async function loginContext(browser: Browser, role: FixtureRole): Promise<LoggedInContext> {
  const account = fixtureAccount(role);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('用户名').fill(account.username);
  await page.getByLabel('密码').fill(account.password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: '德州计分' })).toBeVisible();
  return { context, page };
}
