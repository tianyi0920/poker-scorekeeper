import { expect, test } from '@playwright/test';
import { accounts } from './support/fixtures.js';

test('bootstrap-style forced-password account cannot enter the app before changing password', async ({ page }) => {
  const account = accounts['forced-password'];
  await page.goto('/login');
  await page.getByLabel('用户名').fill(account.username);
  await page.getByLabel('密码').fill(account.password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/change-password$/);

  await page.goto('/');
  await expect(page).toHaveURL(/\/change-password$/);
  await page.getByLabel('当前密码').fill(account.password);
  await page.getByLabel('新密码').fill('Task18-only-forced-changed-67890');
  await page.getByRole('button', { name: '保存新密码' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: '当前对局' })).toBeVisible();
});

test('invalid credentials stay on the login page with a controlled error', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('用户名').fill(accounts.outsider.username);
  await page.getByLabel('密码').fill('Task18-definitely-wrong-password');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText('用户名或密码错误')).toBeVisible();
});
