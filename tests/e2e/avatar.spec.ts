import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { apiLogin, apiWrite, closeApiSessions } from './support/api.js';
import { loginContext } from './support/auth.js';
import { accounts } from './support/fixtures.js';

const requireFromApi = createRequire(resolve('apps/api/package.json'));
const sharp = requireFromApi('sharp') as (options: Record<string, unknown>) => {
  png(): { toBuffer(): Promise<Buffer> };
};

test('custom avatar upload is visible to an administrator and reset returns the account to the default', async ({ browser }) => {
  const player = await apiLogin('player-a');
  const admin = await apiLogin('admin');
  try {
    const validPng = await sharp({
      create: { width: 320, height: 240, channels: 4, background: '#3b82f6' }
    }).png().toBuffer();
    const uploaded = await player.context.post('/api/me/avatar/upload', {
      headers: { 'X-CSRF-Token': player.csrfToken },
      multipart: {
        file: { name: 'task18-avatar.png', mimeType: 'image/png', buffer: validPng }
      }
    });
    expect(uploaded.status()).toBe(201);
    const uploadBody = await uploaded.json() as { avatarKind: string; avatarValue: string };
    expect(uploadBody).toMatchObject({ avatarKind: 'UPLOAD' });
    expect(uploadBody.avatarValue).toMatch(/^[a-z0-9-]+\.webp$/);

    const browserSession = await loginContext(browser, 'admin');
    try {
      await browserSession.page.goto('/users');
      const card = browserSession.page.locator('.user-card').filter({ hasText: accounts['player-a'].nickname });
      await expect(card.locator('img')).toHaveAttribute('src', `/avatars/uploads/${uploadBody.avatarValue}`);
      await card.getByRole('button', { name: '重置头像' }).click();
      await browserSession.page.getByRole('button', { name: '确认重置' }).click();
      await expect(card.locator('img')).toHaveAttribute('src', '/avatars/preset-01.webp');
    } finally {
      await browserSession.context.close();
    }

    const state = await admin.context.get('/api/users');
    expect(state.status()).toBe(200);
    const users = (await state.json() as { users: Array<{ id: string; avatarKind: string; avatarValue: string }> }).users;
    expect(users.find(({ id }) => id === accounts['player-a'].id)).toMatchObject({ avatarKind: 'PRESET', avatarValue: 'preset-01' });
  } finally {
    await closeApiSessions(player, admin);
  }
});
