import { expect, test, type BrowserContext } from "@playwright/test";
import {
  apiBuyHands,
  apiLogin,
  closeApiSessions,
  completeBalancedGameApi,
  createStartedGame,
} from "./support/api.js";
import { loginContext } from "./support/auth.js";
import { cleanupTaskGame, readGameGraphCounts } from "./support/database.js";

const deletionWarning =
  "购买记录、玩家锁、结算草稿、结算结果及费用分摊将一并永久删除，无法恢复。";

async function closeBrowserContexts(
  ...contexts: Array<BrowserContext | undefined>
): Promise<void> {
  await Promise.all(
    contexts
      .filter((context): context is BrowserContext => context !== undefined)
      .map((context) => context.close()),
  );
}

async function cleanupExistingFixture(
  gameId: string | undefined,
): Promise<void> {
  if (gameId === undefined) return;
  const counts = await readGameGraphCounts(gameId);
  if (counts.games === 1) await cleanupTaskGame(gameId);
}

test("super admin hard deletes an active joined table and every target business row", async ({
  browser,
}) => {
  // Break caught: active hard delete leaves business rows/locks behind or misses online table clients.
  const admin = await apiLogin("admin");
  const player = await apiLogin("player-a");
  let liveContext: BrowserContext | undefined;
  let superAdminContext: BrowserContext | undefined;
  let gameId: string | undefined;
  try {
    const game = await createStartedGame(
      admin,
      "活动局永久删除",
      "300",
      (createdId) => {
        gameId = createdId;
      },
    );

    const live = await loginContext(browser, "admin");
    liveContext = live.context;
    await live.page.goto(`/games/${encodeURIComponent(game.id)}`);
    await expect(
      live.page.getByRole("heading", { name: game.name, exact: true }),
    ).toBeVisible();
    await expect(
      live.page.getByText("玩家 0/12", { exact: true }),
    ).toBeVisible();

    let snapshotRequestsAfterInitialRender = 0;
    const countSnapshotRequests = (request: {
      method(): string;
      url(): string;
    }) => {
      const url = new URL(request.url());
      if (
        request.method() === "GET" &&
        url.pathname === `/api/games/${encodeURIComponent(game.id)}/snapshot`
      )
        snapshotRequestsAfterInitialRender += 1;
    };
    live.page.on("request", countSnapshotRequests);
    try {
      const bought = await apiBuyHands(
        player,
        game.id,
        3,
        "hard-delete-active-player-lock",
      );
      expect(bought.status()).toBe(201);
      await expect(
        live.page.getByText("玩家 1/12", { exact: true }),
      ).toBeVisible({ timeout: 5_000 });
      await expect(
        live.page
          .getByTestId("table-seat")
          .filter({ hasText: player.user.nickname }),
      ).toHaveCount(1);
      expect(snapshotRequestsAfterInitialRender).toBe(0);
    } finally {
      live.page.off("request", countSnapshotRequests);
    }

    expect(await readGameGraphCounts(game.id)).toEqual({
      settlementFeeAllocations: 0,
      settlementResults: 0,
      settlements: 0,
      settlementDrafts: 0,
      buyinEvents: 1,
      activePlayerLocks: 1,
      gamePlayers: 1,
      games: 1,
      hardDeleteAudits: 0,
    });

    const superAdmin = await loginContext(browser, "super-admin");
    superAdminContext = superAdmin.context;
    await superAdmin.page.goto("/games/manage");
    const targetRow = superAdmin.page.getByRole("article", {
      name: game.name,
      exact: true,
    });
    await expect(targetRow).toHaveCount(1);
    await targetRow
      .getByRole("button", { name: `永久删除 ${game.name}`, exact: true })
      .click();

    const dialogs = superAdmin.page.getByRole("dialog", {
      name: "永久删除对局",
      exact: true,
    });
    await expect(dialogs).toHaveCount(1);
    await expect(
      dialogs.getByText(deletionWarning, { exact: true }),
    ).toHaveCount(1);
    const deletedResponse = superAdmin.page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "DELETE" &&
        url.pathname === `/api/games/${encodeURIComponent(game.id)}`
      );
    });
    await dialogs
      .getByRole("button", { name: "确认永久删除", exact: true })
      .click();
    expect((await deletedResponse).status()).toBe(200);

    await expect(targetRow).toHaveCount(0);
    await expect(superAdmin.page.getByRole("dialog")).toHaveCount(0);
    await expect(live.page).toHaveURL(/\/$/);
    await expect(
      live.page.getByRole("status", { name: "对局删除提示", exact: true }),
    ).toHaveText("该对局已由超级管理员删除");
    expect(await readGameGraphCounts(game.id)).toEqual({
      settlementFeeAllocations: 0,
      settlementResults: 0,
      settlements: 0,
      settlementDrafts: 0,
      buyinEvents: 0,
      activePlayerLocks: 0,
      gamePlayers: 0,
      games: 0,
      hardDeleteAudits: 1,
    });
  } finally {
    await closeBrowserContexts(liveContext, superAdminContext);
    await closeApiSessions(admin, player);
    await cleanupExistingFixture(gameId);
  }
});

test("super admin hard deletes a completed game from management and uncached history", async ({
  browser,
}) => {
  // Break caught: completed hard delete removes only the game row or stale client storage hides server history.
  const admin = await apiLogin("admin");
  const playerA = await apiLogin("player-a");
  const playerB = await apiLogin("player-b");
  let participantContext: BrowserContext | undefined;
  let superAdminContext: BrowserContext | undefined;
  let freshParticipantContext: BrowserContext | undefined;
  let gameId: string | undefined;
  try {
    const completed = await completeBalancedGameApi(
      admin,
      playerA,
      playerB,
      "完成局永久删除",
      (createdId) => {
        gameId = createdId;
      },
    );
    const game = completed.game;

    const participantDetail = await playerA.context.get(
      `/api/history/${encodeURIComponent(game.id)}`,
    );
    expect(participantDetail.status()).toBe(200);
    expect(await participantDetail.json()).toMatchObject({
      game: { id: game.id, name: game.name },
      immutable: true,
    });
    const participantHistory = await playerA.context.get(
      "/api/history?limit=50",
    );
    expect(participantHistory.status()).toBe(200);
    const participantHistoryBody = (await participantHistory.json()) as {
      items: Array<{ gameId: string; name: string }>;
    };
    expect(
      participantHistoryBody.items.filter((item) => item.gameId === game.id),
    ).toEqual([expect.objectContaining({ gameId: game.id, name: game.name })]);

    const participant = await loginContext(browser, "player-a");
    participantContext = participant.context;
    await participant.page.goto("/history");
    await expect(
      participant.page.locator(".result-row", { hasText: game.name }),
    ).toHaveCount(1);
    await participant.page.goto(`/history/${encodeURIComponent(game.id)}`);
    await expect(participant.page.getByLabel("历史结算明细")).toBeVisible();
    await expect(
      participant.page.getByRole("heading", { name: game.name, exact: true }),
    ).toBeVisible();

    const countsBeforeDelete = await readGameGraphCounts(game.id);
    expect(countsBeforeDelete).toMatchObject({
      games: 1,
      gamePlayers: 3,
      buyinEvents: 3,
      activePlayerLocks: 0,
      settlementDrafts: 1,
      settlements: 1,
      settlementResults: 3,
      hardDeleteAudits: 0,
    });
    expect(countsBeforeDelete.settlementFeeAllocations).toBeGreaterThan(0);

    const superAdmin = await loginContext(browser, "super-admin");
    superAdminContext = superAdmin.context;
    await superAdmin.page.goto("/games/manage");
    const targetRow = superAdmin.page.getByRole("article", {
      name: game.name,
      exact: true,
    });
    await expect(targetRow).toHaveCount(1);
    await targetRow
      .getByRole("button", { name: `永久删除 ${game.name}`, exact: true })
      .click();
    const dialog = superAdmin.page.getByRole("dialog", {
      name: "永久删除对局",
      exact: true,
    });
    await expect(dialog).toHaveCount(1);
    await expect(
      dialog.getByText(deletionWarning, { exact: true }),
    ).toHaveCount(1);
    const deletedResponse = superAdmin.page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "DELETE" &&
        url.pathname === `/api/games/${encodeURIComponent(game.id)}`
      );
    });
    await dialog
      .getByRole("button", { name: "确认永久删除", exact: true })
      .click();
    expect((await deletedResponse).status()).toBe(200);
    await expect(targetRow).toHaveCount(0);

    const uncachedDetail = await playerA.context.get(
      `/api/history/${encodeURIComponent(game.id)}`,
      {
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
      },
    );
    expect(uncachedDetail.status()).toBe(404);
    expect(await uncachedDetail.json()).toMatchObject({
      code: "HISTORY_SCOPE_DENIED",
    });
    const uncachedHistory = await playerA.context.get("/api/history?limit=50", {
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
    });
    expect(uncachedHistory.status()).toBe(200);
    const uncachedHistoryBody = (await uncachedHistory.json()) as {
      items: Array<{ gameId: string }>;
    };
    expect(
      uncachedHistoryBody.items.some((item) => item.gameId === game.id),
    ).toBe(false);

    const freshParticipant = await loginContext(browser, "player-a");
    freshParticipantContext = freshParticipant.context;
    await freshParticipant.page.goto(`/history/${encodeURIComponent(game.id)}`);
    await expect(
      freshParticipant.page.getByText("该历史结算不存在，或你没有查看权限。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(freshParticipant.page.getByLabel("历史结算明细")).toHaveCount(
      0,
    );

    expect(await readGameGraphCounts(game.id)).toEqual({
      settlementFeeAllocations: 0,
      settlementResults: 0,
      settlements: 0,
      settlementDrafts: 0,
      buyinEvents: 0,
      activePlayerLocks: 0,
      gamePlayers: 0,
      games: 0,
      hardDeleteAudits: 1,
    });
  } finally {
    await closeBrowserContexts(
      participantContext,
      superAdminContext,
      freshParticipantContext,
    );
    await closeApiSessions(admin, playerA, playerB);
    await cleanupExistingFixture(gameId);
  }
});
