import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.integration-spec.ts'],
    passWithNoTests: true,
    setupFiles: ['./test/setup.ts']
  }
});
