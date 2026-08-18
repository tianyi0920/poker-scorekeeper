import type { UserConfig } from 'vitest/config';
import { describe, expect, it } from 'vitest';
import e2eConfig from '../vitest.e2e.config.js';
import unitConfig from '../vitest.config.js';

function testOptions(config: UserConfig): NonNullable<UserConfig['test']> {
  expect(config.test).toBeDefined();
  return config.test!;
}

describe('API Vitest suite boundaries', () => {
  it('keeps the default suite on unit budgets without collecting E2E files', () => {
    expect(testOptions(unitConfig)).toMatchObject({
      testTimeout: 15_000,
      hookTimeout: 10_000,
      include: ['src/**/*.test.ts', 'test/**/*.spec.ts']
    });
  });

  it('gives only remote-database E2E files the extended serial budgets', () => {
    expect(testOptions(e2eConfig)).toMatchObject({
      fileParallelism: false,
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
      testTimeout: 30_000,
      hookTimeout: 30_000,
      include: ['test/**/*.e2e-spec.ts']
    });
  });
});
