import { expect, test } from '@playwright/test';
import {
  apiBuyHands,
  apiLogin,
  apiLoginAccount,
  apiWrite,
  closeApiSessions,
  createStartedGame,
  type ApiSession
} from './support/api.js';
import { cleanupTaskGame } from './support/database.js';
import { fixtureAccount, tablePlayers } from './support/fixtures.js';

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
    const arenaGeometry = await page.evaluate(() => {
      const table = document.querySelector<HTMLElement>('[data-testid="round-table"]');
      const felt = document.querySelector<HTMLElement>('.poker-felt');
      const dock = document.querySelector<HTMLElement>('.game-action-dock');
      const controls = document.querySelector<HTMLElement>('.game-controls');
      const voiceToggle = document.querySelector<HTMLElement>('.voice-toggle');
      const spectatorBar = document.querySelector<HTMLElement>('.spectator-bar');
      if (!table || !felt || !dock || !controls || !voiceToggle || !spectatorBar) throw new Error('竞技区关键元素未渲染');
      const tableRect = table.getBoundingClientRect();
      const feltRect = felt.getBoundingClientRect();
      const dockRect = dock.getBoundingClientRect();
      const controlsRect = controls.getBoundingClientRect();
      const voiceToggleRect = voiceToggle.getBoundingClientRect();
      const spectatorRect = spectatorBar.getBoundingClientRect();
      const seats = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="table-seat"]'))
        .map((seat) => seat.getBoundingClientRect())
        .map((rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }));
      const seatOverlaps: Array<[number, number]> = [];
      for (let leftIndex = 0; leftIndex < seats.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < seats.length; rightIndex += 1) {
          const left = seats[leftIndex]!;
          const right = seats[rightIndex]!;
          if (left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top) {
            seatOverlaps.push([leftIndex + 1, rightIndex + 1]);
          }
        }
      }
      return {
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        tableTop: tableRect.top,
        tableBottom: tableRect.bottom,
        tableWidth: tableRect.width,
        tableHeight: tableRect.height,
        feltWidth: feltRect.width,
        feltHeight: feltRect.height,
        controlsHeight: controlsRect.height,
        voiceToggleWidth: voiceToggleRect.width,
        voiceToggleHeight: voiceToggleRect.height,
        dockWidth: dockRect.width,
        dockTop: dockRect.top,
        spectatorTop: spectatorRect.top,
        spectatorBottom: spectatorRect.bottom,
        seats,
        seatOverlaps
      };
    });
    expect(arenaGeometry.scrollHeight).toBeLessThanOrEqual(arenaGeometry.viewportHeight);
    expect(arenaGeometry.spectatorTop).toBeGreaterThanOrEqual(0);
    expect(arenaGeometry.spectatorBottom).toBeLessThanOrEqual(arenaGeometry.tableTop);
    expect(arenaGeometry.tableBottom).toBeLessThanOrEqual(arenaGeometry.dockTop);
    expect(arenaGeometry.feltWidth / arenaGeometry.tableWidth).toBeGreaterThanOrEqual(0.77);
    expect(arenaGeometry.feltHeight).toBeGreaterThanOrEqual(arenaGeometry.tableHeight - 58);
    expect(arenaGeometry.controlsHeight).toBe(44);
    expect(arenaGeometry.voiceToggleWidth).toBeGreaterThanOrEqual(44);
    expect(arenaGeometry.voiceToggleHeight).toBeGreaterThanOrEqual(44);
    expect(arenaGeometry.dockWidth).toBeLessThanOrEqual(arenaGeometry.viewportWidth - 40);
    expect(arenaGeometry.seatOverlaps).toEqual([]);
    expect(arenaGeometry.seats.every((seat) => (
      seat.left >= 0 &&
      seat.right <= arenaGeometry.viewportWidth &&
      seat.top >= 0 &&
      seat.bottom <= arenaGeometry.dockTop
    ))).toBe(true);
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
      const positionedScrollY = await table.evaluate((element) => {
        element.scrollIntoView({ block: 'center', inline: 'nearest' });
        return window.scrollY;
      });
      const geometry = await page.evaluate(() => {
        const table = document.querySelector<HTMLElement>('[data-testid="round-table"]');
        const dock = document.querySelector<HTMLElement>('.game-action-dock');
        if (!table || !dock) throw new Error('牌桌或固定购买栏未渲染');

        const dockRect = dock.getBoundingClientRect();
        const inspect = (element: HTMLElement | null) => {
          if (!element) return { missing: true, display: 'missing', visibility: 'missing', opacity: 0, width: 0, height: 0, inViewport: false, overlapsDock: false };
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            missing: false,
            display: style.display,
            visibility: style.visibility,
            opacity: Number.parseFloat(style.opacity),
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            inViewport: rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight,
            overlapsDock: rect.left < dockRect.right && rect.right > dockRect.left && rect.top < dockRect.bottom && rect.bottom > dockRect.top
          };
        };
        const seats = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="table-seat"]')).map((seat) => ({
          seat: inspect(seat),
          image: inspect(seat.querySelector('img')),
          nickname: inspect(seat.querySelector('strong')),
          hands: inspect(seat.querySelector(':scope > span:not(.visually-hidden)')),
          amount: inspect(seat.querySelector('b'))
        }));
        const seatOverlaps: Array<[number, number]> = [];
        for (let leftIndex = 0; leftIndex < seats.length; leftIndex += 1) {
          for (let rightIndex = leftIndex + 1; rightIndex < seats.length; rightIndex += 1) {
            const left = seats[leftIndex]!.seat;
            const right = seats[rightIndex]!.seat;
            if (left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top) {
              seatOverlaps.push([leftIndex, rightIndex]);
            }
          }
        }

        return {
          density: table.className,
          computedHeight: Number.parseFloat(getComputedStyle(table).height),
          renderedHeight: table.getBoundingClientRect().height,
          horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
          scrollY: window.scrollY,
          seats,
          seatOverlaps
        };
      });

      expect(geometry.density).toContain('round-table--sparse');
      expect(geometry.computedHeight).toBeGreaterThanOrEqual(240);
      expect(geometry.renderedHeight).toBeGreaterThanOrEqual(240);
      expect(geometry.horizontalOverflow).toBeLessThanOrEqual(0);
      expect(geometry.scrollY).toBe(positionedScrollY);
      expect(geometry.seatOverlaps, JSON.stringify({ width, ...geometry })).toEqual([]);
      expect(
        geometry.seats.every((seat) => Object.values(seat).every((part) => (
          !part.missing
          && part.display !== 'none'
          && part.visibility !== 'hidden'
          && part.opacity > 0
          && part.width > 0
          && part.height > 0
          && part.inViewport
          && !part.overlapsDock
        ))),
        JSON.stringify({ width, ...geometry })
      ).toBe(true);
    }
  } finally {
    await closeApiSessions(admin, ...playerSessions);
    if (gameId) await cleanupTaskGame(gameId);
  }
});

test('administrator end-game control and a long latest speech stay inside the fitted arena', async ({ page }, testInfo) => {
  test.skip(
    !['chromium-320x568', 'chromium-360x800', 'webkit-430x932'].includes(testInfo.project.name),
    '只在最窄 Chromium 与较宽 iPhone WebKit 视口验证管理员完整几何。'
  );

  const admin = await apiLogin('admin');
  const playerSessions: ApiSession[] = [];
  let gameId: string | undefined;
  try {
    const adminAccount = fixtureAccount('admin');
    await page.goto('/login');
    await page.getByLabel('用户名').fill(adminAccount.username);
    await page.getByLabel('密码').fill(adminAccount.password);
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page).toHaveURL(/\/$/);

    const game = await createStartedGame(
      admin,
      `管理员竞技区 ${testInfo.project.name}`,
      '300',
      (createdGameId) => { gameId = createdGameId; }
    );
    gameId = game.id;
    for (const [index, account] of tablePlayers.entries()) {
      const session = await apiLoginAccount(account);
      playerSessions.push(session);
      expect((await apiBuyHands(session, game.id, 1, `admin-layout-${testInfo.project.name}-${index}`)).status()).toBe(201);
    }
    await page.goto(`/games/${game.id}`);
    await expect(page.getByTestId('table-seat')).toHaveCount(12);
    await expect(page.getByRole('button', { name: '结束对局' })).toBeVisible();
    await expect(page.getByRole('link', { name: '返回首页' })).toBeVisible();
    await expect(page.getByRole('status', { name: '最新购买记录' })).toBeVisible();
    await expect(page.locator('.community-card--back')).toHaveCount(5);
    const speechSenders = testInfo.project.name === 'chromium-320x568'
      ? playerSessions
      : [playerSessions[4]!];
    for (const [senderIndex, sender] of speechSenders.entries()) {
      const speechText = `第${senderIndex + 1}个座位发言，用来检查气泡不会遮挡其他牌友`;
      expect((await apiWrite(
        sender,
        'post',
        `/api/games/${encodeURIComponent(game.id)}/messages`,
        { text: speechText }
      )).status()).toBe(201);
      await expect(page.getByText(speechText)).toBeVisible();
      await expect(page.getByRole('tab', { name: `消息区 ${senderIndex + 1}` })).toBeVisible();

      const geometry = await page.evaluate((currentSpeechText) => {
        const table = document.querySelector<HTMLElement>('[data-testid="round-table"]');
        const dock = document.querySelector<HTMLElement>('.game-action-dock');
        const spectatorBar = document.querySelector<HTMLElement>('.spectator-bar');
        const endButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
          .find((button) => button.textContent?.trim() === '结束对局');
        const speechElement = Array.from(document.querySelectorAll<HTMLElement>('.seat-speech'))
          .find((element) => element.textContent === currentSpeechText);
        if (!table || !dock || !spectatorBar || !endButton || !speechElement) {
          throw new Error('管理员竞技区关键元素未渲染');
        }
        const tableRect = table.getBoundingClientRect();
        const dockRect = dock.getBoundingClientRect();
        const spectatorRect = spectatorBar.getBoundingClientRect();
        const endRect = endButton.getBoundingClientRect();
        const speechRect = speechElement.getBoundingClientRect();
        const ownSeat = speechElement.closest('[data-testid="table-seat"]');
        const ownAmount = ownSeat?.querySelector<HTMLElement>('b');
        if (!ownAmount) throw new Error('发言人的当前购买金额未渲染');
        const overlaps = (left: DOMRect, right: DOMRect) => (
          left.left < right.right && left.right > right.left &&
          left.top < right.bottom && left.bottom > right.top
        );
        const overlappingSeats = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="table-seat"]'))
          .filter((seat) => seat !== ownSeat && overlaps(speechRect, seat.getBoundingClientRect()))
          .map((seat) => seat.getAttribute('aria-label'));
        return {
          horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
          verticalOverflow: document.documentElement.scrollHeight - window.innerHeight,
          tableBottom: tableRect.bottom,
          dockTop: dockRect.top,
          endHeight: endRect.height,
          speechLeft: speechRect.left,
          speechRight: speechRect.right,
          viewportWidth: window.innerWidth,
          overlapsSpectatorBar: overlaps(speechRect, spectatorRect),
          overlapsOwnAmount: overlaps(speechRect, ownAmount.getBoundingClientRect()),
          overlappingSeats
        };
      }, speechText);

      expect(geometry.horizontalOverflow).toBeLessThanOrEqual(0);
      expect(geometry.verticalOverflow).toBeLessThanOrEqual(0);
      expect(geometry.tableBottom - geometry.dockTop).toBeLessThanOrEqual(1);
      expect(geometry.endHeight).toBeGreaterThanOrEqual(44);
      expect(geometry.speechLeft).toBeGreaterThanOrEqual(0);
      expect(geometry.speechRight).toBeLessThanOrEqual(geometry.viewportWidth);
      expect(geometry.overlapsSpectatorBar, speechText).toBe(false);
      expect(geometry.overlapsOwnAmount, speechText).toBe(false);
      expect(geometry.overlappingSeats, speechText).toEqual([]);
    }
  } finally {
    await closeApiSessions(admin, ...playerSessions);
    if (gameId) await cleanupTaskGame(gameId);
  }
});
