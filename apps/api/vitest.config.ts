import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    globals: true,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 15_000,
    hookTimeout: 10_000,
    include: ['src/**/*.test.ts', 'test/**/*.spec.ts'],
    setupFiles: ['./test/setup.ts']
  }
});
