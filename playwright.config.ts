import { defineConfig, devices } from '@playwright/test';
import { randomUUID } from 'node:crypto';

process.env.TASK18_RUN_ID ??= `t18${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 4)}`;

const mobileProjects = [
  { browser: 'chromium', width: 320, height: 568 },
  { browser: 'chromium', width: 360, height: 800 },
  { browser: 'chromium', width: 430, height: 932 },
  { browser: 'webkit', width: 360, height: 800 },
  { browser: 'webkit', width: 430, height: 932 }
] as const;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'test-results/playwright-report', open: 'never' }]
  ],
  outputDir: 'test-results/playwright-artifacts',
  globalSetup: './tests/e2e/global-setup.ts',
  webServer: {
    command: 'node node_modules/tsx/dist/cli.mjs tests/e2e/support/server.ts',
    url: 'http://127.0.0.1:3000/api/health/live',
    reuseExistingServer: false,
    timeout: 120_000
  },
  use: {
    baseURL: 'http://127.0.0.1:3000',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off'
  },
  projects: mobileProjects.map(({ browser, width, height }) => ({
    name: `${browser}-${width}x${height}`,
    ...(
      browser === 'chromium' && width === 360
        ? {}
        : browser === 'webkit' && width === 430
          ? { testMatch: /(?:game-flow|mobile-layout)\.spec\.ts/ }
          : { testMatch: /mobile-layout\.spec\.ts/ }
    ),
    use: {
      ...(browser === 'chromium' ? devices['Desktop Chrome'] : devices['Desktop Safari']),
      browserName: browser,
      viewport: { width, height },
      isMobile: true,
      hasTouch: true
    }
  }))
});
