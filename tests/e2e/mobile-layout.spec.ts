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

test('four-seat table keeps sparse mobile geometry and reachable player cards at 360, 390, and 430px', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('chromium-'), '该回归只验证 Chromium 的真实移动端几何。');

  const admin = await apiLogin('admin');
  const playerSessions: ApiSession[] = [];
  let gameId: string | undefined;
  try {
    const self = tablePlayers[0];
    await page.goto('/login');
    await page.getByLabel('用户名').fill(self.username);
    await page.getByLabel('密码').fill(self.password);
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page).toHaveURL(/\/$/);

    const game = await createStartedGame(
      admin,
      `4人稀疏布局 ${testInfo.project.name}`,
      '300',
      (createdGameId) => { gameId = createdGameId; }
    );
    gameId = game.id;
    for (const [index, account] of tablePlayers.slice(0, 4).entries()) {
      const session = await apiLoginAccount(account);
      playerSessions.push(session);
      const bought = await apiBuyHands(session, game.id, 1, `sparse-layout-${testInfo.project.name}-${index}`);
      expect(bought.status()).toBe(201);
    }

    await page.goto(`/games/${game.id}`);
    const table = page.getByTestId('round-table');
    await expect(page.getByTestId('table-seat')).toHaveCount(4);
    await expect(table).toHaveClass(/round-table--sparse/);

    for (const width of [360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      const geometry = await page.evaluate(() => {
        const table = document.querySelector<HTMLElement>('[data-testid="round-table"]');
        const dock = document.querySelector<HTMLElement>('.game-action-dock');
        if (!table || !dock) throw new Error('牌桌或固定购买栏未渲染');

        const dockRect = dock.getBoundingClientRect();
        const seats = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="table-seat"]')).map((seat) => {
          seat.scrollIntoView({ block: 'center', inline: 'nearest' });
          const rect = seat.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            overlapsDock: rect.left < dockRect.right && rect.right > dockRect.left && rect.top < dockRect.bottom && rect.bottom > dockRect.top,
            reachableAboveDock: rect.top >= 0 && rect.bottom <= dockRect.top
          };
        });

        return {
          density: table.className,
          computedHeight: Number.parseFloat(getComputedStyle(table).height),
          renderedHeight: table.getBoundingClientRect().height,
          horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
          dockTop: dockRect.top,
          seats
        };
      });

      expect(geometry.density).toContain('round-table--sparse');
      expect(geometry.computedHeight).toBeGreaterThanOrEqual(280);
      expect(geometry.computedHeight).toBeLessThanOrEqual(320);
      expect(geometry.renderedHeight).toBeGreaterThanOrEqual(280);
      expect(geometry.renderedHeight).toBeLessThanOrEqual(320);
      expect(geometry.horizontalOverflow).toBeLessThanOrEqual(0);
      expect(
        geometry.seats.every((seat) => seat.width > 0 && seat.height > 0 && !seat.overlapsDock && seat.reachableAboveDock),
        JSON.stringify({ width, ...geometry })
      ).toBe(true);
    }
  } finally {
    await closeApiSessions(admin, ...playerSessions);
    if (gameId) await cleanupTaskGame(gameId);
  }
});
