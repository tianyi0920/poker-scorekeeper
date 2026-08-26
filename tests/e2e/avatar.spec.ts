import { expect, test, type Page, type Request, type Route } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { apiLogin, closeApiSessions } from './support/api.js';
import { loginContext } from './support/auth.js';
import { accounts } from './support/fixtures.js';

const requireFromApi = createRequire(resolve('apps/api/package.json'));
const sharp = requireFromApi('sharp') as (options: Record<string, unknown>) => {
  png(): { toBuffer(): Promise<Buffer> };
};

function isRequest(request: Request, method: string, pathname: string): boolean {
  return request.method() === method && new URL(request.url()).pathname === pathname;
}

function watchRequestCount(page: Page, method: string, pathname: string) {
  const requests: Request[] = [];
  const record = (request: Request) => {
    if (isRequest(request, method, pathname)) requests.push(request);
  };
  page.on('request', record);
  return {
    requests,
    stop: () => page.off('request', record)
  };
}

async function generatedPng(): Promise<Buffer> {
  return sharp({
    create: { width: 640, height: 480, channels: 4, background: '#3b82f6' }
  }).png().toBuffer();
}

test('nickname avatar replaces the preset gallery and persists after reload', async ({ browser }) => {
  const browserSession = await loginContext(browser, 'player-a');
  const { page } = browserSession;
  const presetCatalogRequests = watchRequestCount(page, 'GET', '/api/avatars/presets');
  const presetMutations = watchRequestCount(page, 'PUT', '/api/me/avatar/preset');
  try {
    await page.goto('/profile');
    const currentAvatar = page.getByRole('img', { name: '当前头像' });
    const initial = accounts['player-a'].nickname.trim()[0]!;
    await expect(currentAvatar).toHaveText(initial);
    await expect(page.getByRole('radio')).toHaveCount(0);
    await expect(page.getByText('使用昵称首字作为头像')).toBeVisible();
    await expect(page.getByRole('button', { name: '从相册选择', exact: true })).toBeVisible();
    expect(presetCatalogRequests.requests).toHaveLength(0);
    expect(presetMutations.requests).toHaveLength(0);

    await page.reload();
    await expect(page.getByRole('img', { name: '当前头像' })).toHaveText(initial);
    await expect(page.getByRole('radio')).toHaveCount(0);
    expect(presetCatalogRequests.requests).toHaveLength(0);
    expect(presetMutations.requests).toHaveLength(0);
  } finally {
    presetCatalogRequests.stop();
    presetMutations.stop();
    await browserSession.context.close();
  }
});

test('failed custom upload retains the crop and retries the same file before persisting', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const account = accounts['player-b'];

  await page.goto('/login');
  await page.getByLabel('用户名').fill(account.username);
  await page.getByLabel('密码').fill(account.password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/(home)?$/);
  await expect(page.getByRole('heading', { name: '德州计分' })).toBeVisible();
  const uploadMutations = watchRequestCount(page, 'POST', '/api/me/avatar/upload');
  const failFirstUpload = async (route: Route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ statusCode: 503, code: 'DATABASE_UNAVAILABLE' })
    });
  };
  let releaseSessionRefresh: (() => void) | null = null;
  let gateSessionRefresh: ((route: Route) => Promise<void>) | null = null;
  let sessionGateStarted = false;
  let sessionGateSettled: Promise<void> | null = null;
  try {
    await page.goto('/profile');
    const currentAvatar = page.getByRole('img', { name: '当前头像' });
    await expect(currentAvatar).toHaveText(account.nickname.trim()[0]!);

    const albumButton = page.getByRole('button', { name: '从相册选择', exact: true });
    const fileInput = page.getByLabel('从相册选择文件');
    await expect(albumButton).toBeVisible();
    await expect(fileInput).toBeAttached();
    expect(await fileInput.evaluate((input) => {
      const style = getComputedStyle(input);
      const rect = input.getBoundingClientRect();
      return {
        position: style.position,
        clipPath: style.clipPath,
        width: rect.width,
        height: rect.height
      };
    })).toEqual({ position: 'absolute', clipPath: 'inset(50%)', width: 1, height: 1 });
    await page.evaluate(() => {
      const counters = window as typeof window & {
        avatarFileChanges?: number;
        avatarCropConfirmClicks?: number;
        avatarProgressMessages?: string[];
      };
      counters.avatarFileChanges = 0;
      counters.avatarCropConfirmClicks = 0;
      counters.avatarProgressMessages = [];
      const recordProgress = (message: string | null | undefined) => {
        message = message?.trim();
        if (message && counters.avatarProgressMessages?.at(-1) !== message) {
          counters.avatarProgressMessages?.push(message);
        }
      };
      const captureProgressNode = (node: Node) => {
        if (node instanceof Text) {
          const progress = node.parentElement?.closest('.avatar-upload-progress');
          if (progress !== null && progress !== undefined) recordProgress(progress.textContent);
          return;
        }
        if (!(node instanceof Element)) return;
        if (node.matches('.avatar-upload-progress, .avatar-upload-progress span')) {
          recordProgress(node.textContent);
        }
        node.querySelectorAll('.avatar-upload-progress span').forEach((progress) => {
          recordProgress(progress.textContent);
        });
      };
      new MutationObserver((records) => {
        records.forEach((record) => {
          if (record.type === 'characterData') captureProgressNode(record.target);
          record.addedNodes.forEach(captureProgressNode);
          record.removedNodes.forEach(captureProgressNode);
        });
      }).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
      document.addEventListener('change', (event) => {
        if (event.target instanceof HTMLInputElement && event.target.type === 'file') {
          counters.avatarFileChanges = (counters.avatarFileChanges ?? 0) + 1;
        }
      });
      document.addEventListener('click', (event) => {
        const button = event.target instanceof Element ? event.target.closest('button') : null;
        if (button?.textContent?.trim() === '裁剪并上传') {
          counters.avatarCropConfirmClicks = (counters.avatarCropConfirmClicks ?? 0) + 1;
        }
      }, { capture: true });
    });

    await page.route('**/api/me/avatar/upload', failFirstUpload);
    await fileInput.setInputFiles({
      name: 'task5-avatar.png',
      mimeType: 'image/png',
      buffer: await generatedPng()
    });

    const cropDialog = page.getByRole('dialog', { name: '裁剪头像' });
    await expect(cropDialog).toBeVisible();
    expect(uploadMutations.requests).toHaveLength(0);
    const preview = page.getByRole('img', { name: '待裁剪头像' });
    const previewUrl = await preview.getAttribute('src');
    expect(previewUrl).toMatch(/^blob:/);
    const horizontalPosition = page.getByLabel('水平位置');
    await horizontalPosition.fill('80');
    await expect(horizontalPosition).toHaveValue('80');

    await page.getByRole('button', { name: '裁剪并上传' }).click();
    await expect(page.getByRole('status')).toHaveText(/^正在上传 \d+%$/);
    await expect(page.getByRole('alert')).toHaveText('数据库暂时不可用，请稍后重试');

    expect(uploadMutations.requests).toHaveLength(1);
    await expect(currentAvatar).toHaveText(account.nickname.trim()[0]!);
    await expect(cropDialog).toBeVisible();
    await expect(preview).toHaveAttribute('src', previewUrl!);
    await expect(horizontalPosition).toHaveValue('80');
    await expect(page.getByRole('button', { name: '重新上传' })).toBeVisible();
    await expect(page.getByRole('button', { name: '重新选择照片' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => ({
      fileChanges: (window as typeof window & { avatarFileChanges?: number }).avatarFileChanges,
      cropConfirmClicks: (window as typeof window & { avatarCropConfirmClicks?: number }).avatarCropConfirmClicks
    }))).toEqual({ fileChanges: 1, cropConfirmClicks: 1 });

    await page.unroute('**/api/me/avatar/upload', failFirstUpload);
    let resolveSessionFetch!: () => void;
    let rejectSessionFetch!: (reason?: unknown) => void;
    const sessionFetchReady = new Promise<void>((resolveReady, rejectReady) => {
      resolveSessionFetch = resolveReady;
      rejectSessionFetch = rejectReady;
    });
    const sessionRelease = new Promise<void>((resolveRelease) => {
      releaseSessionRefresh = resolveRelease;
    });
    let resolveSessionGateSettled!: () => void;
    sessionGateSettled = new Promise<void>((resolveSettled) => {
      resolveSessionGateSettled = resolveSettled;
    });
    gateSessionRefresh = async (route: Route) => {
      sessionGateStarted = true;
      try {
        const response = await route.fetch();
        resolveSessionFetch();
        await sessionRelease;
        await route.fulfill({ response });
      } catch (error) {
        rejectSessionFetch(error);
        throw error;
      } finally {
        resolveSessionGateSettled();
      }
    };
    await page.route('**/api/auth/session', gateSessionRefresh, { times: 1 });
    await page.evaluate(() => {
      (window as typeof window & { avatarProgressMessages?: string[] }).avatarProgressMessages = [];
    });
    const uploadedResponse = page.waitForResponse((response) => (
      isRequest(response.request(), 'POST', '/api/me/avatar/upload') && response.status() === 201
    ));
    const refreshedSession = page.waitForResponse((response) => (
      isRequest(response.request(), 'GET', '/api/auth/session') && response.status() === 200
    ));
    await page.getByRole('button', { name: '重新上传' }).click();
    const response = await uploadedResponse;
    const uploaded = await response.json() as { avatarKind: string; avatarValue: string };

    expect(uploaded).toMatchObject({ avatarKind: 'UPLOAD' });
    expect(uploaded.avatarValue).toMatch(/^[a-z0-9-]+\.webp$/);
    const uploadedUrl = `/avatars/uploads/${uploaded.avatarValue}`;
    expect(uploadMutations.requests).toHaveLength(2);
    await sessionFetchReady;
    await expect(currentAvatar).toHaveAttribute('src', uploadedUrl);
    await expect(page.getByRole('button', { name: '从相册选择', exact: true })).toBeDisabled();
    await expect(fileInput).toBeDisabled();
    await expect(cropDialog).toBeVisible();
    await expect(horizontalPosition).toBeDisabled();
    await expect(page.getByLabel('垂直位置')).toBeDisabled();
    await expect(page.getByRole('button', { name: '裁剪并上传' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '取消' })).toBeDisabled();
    await expect(cropDialog.getByRole('button', { name: '关闭' })).toBeDisabled();
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { avatarProgressMessages?: string[] }).avatarProgressMessages ?? []
    ))).toContainEqual(expect.stringMatching(/^正在上传 (?:[1-9]\d?|100)%$/));
    await expect.poll(() => page.evaluate(() => ({
      fileChanges: (window as typeof window & { avatarFileChanges?: number }).avatarFileChanges,
      cropConfirmClicks: (window as typeof window & { avatarCropConfirmClicks?: number }).avatarCropConfirmClicks
    }))).toEqual({ fileChanges: 1, cropConfirmClicks: 1 });
    releaseSessionRefresh();
    expect((await refreshedSession).status()).toBe(200);
    await sessionGateSettled;
    await page.unroute('**/api/auth/session', gateSessionRefresh);
    gateSessionRefresh = null;
    await expect(currentAvatar).toHaveAttribute('src', uploadedUrl);
    await expect(cropDialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: '从相册选择', exact: true })).toBeEnabled();
    await expect(fileInput).toBeEnabled();

    await page.reload();
    await expect(page.getByRole('img', { name: '当前头像' })).toHaveAttribute('src', uploadedUrl);
    expect(uploadMutations.requests).toHaveLength(2);
  } finally {
    releaseSessionRefresh?.();
    if (sessionGateStarted && sessionGateSettled !== null) {
      await sessionGateSettled.catch(() => undefined);
    }
    if (gateSessionRefresh !== null) {
      await page.unroute('**/api/auth/session', gateSessionRefresh).catch(() => undefined);
    }
    await page.unroute('**/api/me/avatar/upload', failFirstUpload).catch(() => undefined);
    uploadMutations.stop();
    await context.close();
  }
});

test('custom avatar upload is visible to an administrator and reset returns the account to the default', async ({ browser }) => {
  const player = await apiLogin('player-a');
  const admin = await apiLogin('admin');
  try {
    const uploaded = await player.context.post('/api/me/avatar/upload', {
      headers: { 'X-CSRF-Token': player.csrfToken },
      multipart: {
        file: { name: 'task5-admin-avatar.png', mimeType: 'image/png', buffer: await generatedPng() }
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
      await expect(card.locator('.user-avatar')).toHaveAttribute('src', `/avatars/uploads/${uploadBody.avatarValue}`);
      await card.getByRole('button', { name: '恢复昵称头像' }).click();
      await browserSession.page.getByRole('button', { name: '确认重置' }).click();
      await expect(card.locator('.user-avatar')).toHaveText(accounts['player-a'].nickname.trim()[0]!);
      await expect(card.locator('img.user-avatar')).toHaveCount(0);
    } finally {
      await browserSession.context.close();
    }

    const state = await admin.context.get('/api/users');
    expect(state.status()).toBe(200);
    const users = (await state.json() as { users: Array<{ id: string; avatarKind: string; avatarValue: string }> }).users;
    expect(users.find(({ id }) => id === accounts['player-a'].id)).toMatchObject({ avatarKind: 'PRESET', avatarValue: 'preset-13' });
  } finally {
    await closeApiSessions(player, admin);
  }
});
