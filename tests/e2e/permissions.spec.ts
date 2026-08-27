import { expect, test } from '@playwright/test';
import { apiLogin, apiWrite, closeApiSessions } from './support/api.js';
import { accounts } from './support/fixtures.js';
import { loginContext } from './support/auth.js';

test('backend rejects every representative role escalation while the UI hides protected routes', async ({ browser }) => {
  const admin = await apiLogin('admin');
  const player = await apiLogin('outsider');
  const runId = process.env.TASK18_RUN_ID!;
  try {
    const createAdmin = await apiWrite(admin, 'post', '/api/users', {
      username: `${runId}-denied-admin`,
      nickname: `越权管理员${runId.slice(-4)}`,
      initialPassword: 'Task18-only-denied-12345',
      role: 'ADMIN',
      rakeEnabled: true
    });
    expect(createAdmin.status()).toBe(403);
    expect((await createAdmin.json()).code).toBe('FORBIDDEN');

    const deleteUser = await apiWrite(admin, 'delete', `/api/users/${accounts.outsider.id}`);
    expect(deleteUser.status()).toBe(403);
    expect((await deleteUser.json()).code).toBe('FORBIDDEN');

    const settings = await admin.context.get('/api/settings/rake');
    expect(settings.status()).toBe(200);
    const current = await settings.json() as { threshold: string; bps: number; version: number };
    const changeRake = await apiWrite(admin, 'patch', '/api/settings/rake', current);
    expect(changeRake.status()).toBe(403);
    expect((await changeRake.json()).code).toBe('FORBIDDEN');

    const startGame = await apiWrite(player, 'post', '/api/games/not-a-fixture/start');
    expect(startGame.status()).toBe(403);
    expect((await startGame.json()).code).toBe('FORBIDDEN');
  } finally {
    await closeApiSessions(admin, player);
  }

  const playerBrowser = await loginContext(browser, 'outsider');
  const adminBrowser = await loginContext(browser, 'admin');
  try {
    await playerBrowser.page.goto('/users');
    await expect(playerBrowser.page).toHaveURL(/\/$/);
    await expect(playerBrowser.page.getByRole('heading', { name: '用户管理' })).toHaveCount(0);
    await adminBrowser.page.goto('/settings/rake');
    await expect(adminBrowser.page).toHaveURL(/\/$/);
    await expect(adminBrowser.page.getByRole('heading', { name: '抽成设置' })).toHaveCount(0);
  } finally {
    await Promise.all([playerBrowser.context.close(), adminBrowser.context.close()]);
  }
});
