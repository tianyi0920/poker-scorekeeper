import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('uses the same strict TLS identity semantics as readiness', async () => {
    // Break caught: Prisma and readiness interpret one DATABASE_URL differently.
    const root = await mkdtemp(join(tmpdir(), 'poker-prisma-tls-'));
    try {
      const cert = join(root, 'ca.pem');
      const identity = join(root, 'identity.p12');
      await writeFile(cert, 'ca-data');
      await writeFile(identity, 'identity-data');
      const url = new URL('mysql://user:p%40ss@[::1]:3306/test_database');
      url.searchParams.set('sslaccept', 'strict');
      url.searchParams.set('sslcert', cert);
      url.searchParams.set('sslidentity', identity);
      url.searchParams.set('sslpassword', 'p12-pass');

      expect(buildMariaDbPoolConfig(url.toString(), 'production')).toMatchObject({
        host: '::1',
        password: 'p@ss',
        ssl: {
          rejectUnauthorized: true,
          ca: Buffer.from('ca-data'),
          pfx: Buffer.from('identity-data'),
          passphrase: 'p12-pass'
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
