import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    globals: true,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ['test/**/*.e2e-spec.ts'],
    setupFiles: ['./test/setup.ts']
  }
});
