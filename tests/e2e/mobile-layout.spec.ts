import { expect, test } from '@playwright/test';
import {
  apiBuyHands,
  apiLogin,
  apiLoginAccount,
  closeApiSessions,
  createStartedGame,
  type ApiSession
} from './support/api.js';
import { cleanupTaskGame } from './support/database.js';
import { tablePlayers } from './support/fixtures.js';

for (const playerCount of [1, 8, 12] as const) test(`${playerCount}-seat table has no horizontal overflow, undersized actions, console errors, or hidden self seat`, async ({ page }, testInfo) => {
  const admin = await apiLogin('admin');
  const playerSessions: ApiSession[] = [];
  let gameId: string | undefined;
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  try {
    const self = tablePlayers[0];
    await page.goto('/login');
    await page.getByLabel('用户名').fill(self.username);
    await page.getByLabel('密码').fill(self.password);
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page).toHaveURL(/\/$/);
    // The login shell intentionally probes /auth/session before credentials exist.
    // Acceptance begins after authentication, so only data-page console failures count.
    consoleErrors.length = 0;

    const game = await createStartedGame(
      admin,
      `${playerCount}人布局 ${testInfo.project.name}`,
      '300',
      (createdGameId) => { gameId = createdGameId; }
    );
    gameId = game.id;
    for (const [index, account] of tablePlayers.slice(0, playerCount).entries()) {
      const session = await apiLoginAccount(account);
      playerSessions.push(session);
      const bought = await apiBuyHands(session, game.id, 1, `layout-${testInfo.project.name}-${index}`);
      expect(bought.status()).toBe(201);
    }

    await page.goto(`/games/${game.id}`);
    await expect(page.getByTestId('table-seat')).toHaveCount(playerCount);
    await expect(page.getByTestId('seat-self')).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const undersized = await page.locator('button:visible, a:visible').evaluateAll((elements) => elements
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { label: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '', width: rect.width, height: rect.height };
      })
      .filter(({ width, height }) => width > 0 && height > 0 && (width < 44 || height < 44)));
    expect(undersized, JSON.stringify(undersized)).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await testInfo.attach(`${playerCount}-seat-${testInfo.project.name}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png'
    });
  } finally {
    await closeApiSessions(admin, ...playerSessions);
    if (gameId) await cleanupTaskGame(gameId);
  }
});
