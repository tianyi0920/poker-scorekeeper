import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    globals: true,
    testTimeout: 15_000,
    include: ['test/**/*.integration-spec.ts'],
    passWithNoTests: true,
    setupFiles: ['./test/setup.ts']
  }
});
