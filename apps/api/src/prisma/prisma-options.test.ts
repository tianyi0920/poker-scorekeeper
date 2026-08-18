import { describe, expect, it } from 'vitest';
import {
  buildMariaDbPoolConfig,
  buildPrismaTransactionOptions
} from './prisma.service.js';

const databaseUrl = 'mysql://test-user:test-password@example.test:3306/test_database';

describe('buildMariaDbPoolConfig', () => {
  it('allows longer remote connection and acquisition latency only in tests', () => {
    const config = buildMariaDbPoolConfig(databaseUrl, 'test');

    expect(config).toMatchObject({
      connectionLimit: 3,
      minimumIdle: 1,
      connectTimeout: 10_000,
      acquireTimeout: 30_000
    });
  });

  it('keeps production driver timeout defaults and the production pool size', () => {
    const config = buildMariaDbPoolConfig(databaseUrl, 'production');

    expect(config.connectionLimit).toBe(10);
    expect(config).not.toHaveProperty('connectTimeout');
    expect(config).not.toHaveProperty('acquireTimeout');
    expect(config).not.toHaveProperty('minimumIdle');
  });

  it('allows longer interactive transaction startup and execution only in tests', () => {
    expect(buildPrismaTransactionOptions('test')).toEqual({
      maxWait: 15_000,
      timeout: 20_000
    });
    expect(buildPrismaTransactionOptions('production')).toBeUndefined();
  });
});
