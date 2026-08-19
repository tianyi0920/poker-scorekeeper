import { expect, test } from '@playwright/test';
import {
  apiLogin,
  apiWrite,
  closeApiSessions,
  completeBalancedGameApi,
  prepareBalancedSettlement
} from './support/api.js';
import { loginContext } from './support/auth.js';
import { cleanupTaskGame } from './support/database.js';

test('completed history is immutable, participant-visible in full, outsider-hidden, and all-player aggregated', async ({ browser }) => {
  const admin = await apiLogin('admin');
  const playerA = await apiLogin('player-a');
  const playerB = await apiLogin('player-b');
  const outsider = await apiLogin('outsider');
  let gameId: string | undefined;
  try {
    const completed = await completeBalancedGameApi(
      admin,
      playerA,
      playerB,
      '历史聚合',
      (createdGameId) => { gameId = createdGameId; }
    );
    gameId = completed.game.id;
    const participantDetail = await playerA.context.get(`/api/history/${gameId}`);
    expect(participantDetail.status()).toBe(200);
    expect(await participantDetail.json()).toMatchObject({ immutable: true, players: expect.any(Array) });
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

  if (!gameId) throw new Error('Completed Task18 game id was not captured');

  const browserSession = await loginContext(browser, 'player-a');
  try {
    await browserSession.page.goto(`/history/${gameId}`);
    await expect(browserSession.page.getByLabel('历史结算明细')).toBeVisible();
    await expect(browserSession.page.getByRole('button', { name: /永久锁定结算/ })).toHaveCount(0);
    await expect(browserSession.page.locator('input')).toHaveCount(0);
    await browserSession.page.goto(`/history/summary?games=${gameId}`);
    await expect(browserSession.page.getByRole('heading', { name: '全员汇总' })).toBeVisible();
    await expect(browserSession.page.locator('.aggregate-card')).toHaveCount(3);
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
    const currentResponse = await superAdmin.context.get('/api/settings/rake');
    expect(currentResponse.status()).toBe(200);
    const current = await currentResponse.json() as { threshold: string; bps: number; version: number };
    const updated = await apiWrite(superAdmin, 'patch', '/api/settings/rake', {
      threshold: '0',
      bps: current.bps === 2000 ? 1500 : 2000,
      version: current.version
    });
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
