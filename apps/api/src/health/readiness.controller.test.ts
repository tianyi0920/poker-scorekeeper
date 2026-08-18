import type { ConfigService } from '@nestjs/config';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MariaDbReadinessProbe,
  readinessConnectionConfig,
  type ReadinessConnectionFactory
} from './mariadb-readiness.probe.js';
import { ReadinessController, type ReadinessProbe } from './readiness.controller.js';

describe('database readiness isolation', () => {
  it('destroys timed-out dedicated connections and leaves no pending probe across retries', async () => {
    // Break caught: Promise.race returns while a Prisma/pool query keeps running and consumes capacity.
    let pending = 0;
    const destroy = vi.fn(() => { pending -= 1; });
    const connectionOptions: Array<Record<string, unknown>> = [];
    const factory: ReadinessConnectionFactory = {
      connect: vi.fn(async (options) => {
        connectionOptions.push(options as unknown as Record<string, unknown>);
        pending += 1;
        return {
          query: vi.fn(() => new Promise(() => undefined)),
          end: vi.fn(async () => undefined),
          destroy
        };
      })
    };
    const config = {
      get: (key: string) => ({
        DATABASE_URL: 'mysql://probe_user:top-secret@127.0.0.1:3306/poker_scorekeeper',
        READINESS_TIMEOUT_MS: '25'
      })[key]
    } as ConfigService;
    const probe = new MariaDbReadinessProbe(config, factory);

    await expect(probe.check()).rejects.toThrow();
    await expect(probe.check()).rejects.toThrow();
    expect(pending).toBe(0);
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(connectionOptions).toEqual([
      expect.objectContaining({ connectTimeout: 25, socketTimeout: 25 }),
      expect.objectContaining({ connectTimeout: 25, socketTimeout: 25 })
    ]);
    expect(connectionOptions[0]).not.toHaveProperty('queryTimeout');
    expect(connectionOptions[1]).not.toHaveProperty('queryTimeout');
  });

  it('closes a successful dedicated connection and controller maps failures to stable 503', async () => {
    // Break caught: healthy probes leak sockets or driver diagnostics escape the controller.
    const end = vi.fn(async () => undefined);
    const factory: ReadinessConnectionFactory = {
      connect: vi.fn(async () => ({
        query: vi.fn(async () => [{ ok: 1 }]),
        end,
        destroy: vi.fn()
      }))
    };
    const config = {
      get: (key: string) => key === 'DATABASE_URL'
        ? 'mysql://probe:secret@localhost:3306/poker_scorekeeper'
        : '50'
    } as ConfigService;
    const probe = new MariaDbReadinessProbe(config, factory);
    await expect(probe.check()).resolves.toBeUndefined();
    expect(end).toHaveBeenCalledOnce();

    const failed: ReadinessProbe = { check: vi.fn(async () => { throw new Error('secret'); }) };
    await expect(new ReadinessController(failed).ready()).rejects.toMatchObject({
      code: 'DATABASE_UNAVAILABLE',
      status: 503
    });
  });

  it('keeps MySQL IPv6, percent-encoded credentials, and Prisma TLS URL semantics', async () => {
    // Break caught: readiness silently drops TLS files/options or sends bracketed IPv6 to the driver.
    const root = await mkdtemp(join(tmpdir(), 'poker-readiness-tls-'));
    try {
      const cert = join(root, 'server-ca.pem');
      const identity = join(root, 'client.p12');
      await mkdir(root, { recursive: true });
      await writeFile(cert, 'trusted-ca');
      await writeFile(identity, 'client-identity');
      const url = new URL('mysql://probe:p%40ss@[::1]:3307/poker_scorekeeper');
      url.searchParams.set('sslaccept', 'strict');
      url.searchParams.set('sslcert', cert);
      url.searchParams.set('sslidentity', identity);
      url.searchParams.set('sslpassword', 'identity pass');

      expect(readinessConnectionConfig(url.toString(), 125)).toMatchObject({
        host: '::1',
        port: 3307,
        user: 'probe',
        password: 'p@ss',
        database: 'poker_scorekeeper',
        connectTimeout: 125,
        socketTimeout: 125,
        ssl: {
          rejectUnauthorized: true,
          ca: Buffer.from('trusted-ca'),
          pfx: Buffer.from('client-identity'),
          passphrase: 'identity pass'
        }
      });
      expect(readinessConnectionConfig(
        'mariadb://probe:secret@localhost/db?sslaccept=accept_invalid_certs',
        125
      )).toMatchObject({ ssl: { rejectUnauthorized: false } });
      expect(readinessConnectionConfig(
        'mysql://probe:secret@localhost/db?sslcert=server-ca.pem',
        125,
        root
      )).toMatchObject({
        ssl: {
          rejectUnauthorized: false,
          ca: Buffer.from('trusted-ca')
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports TLS configuration failures without exposing a secret file path', () => {
    // Break caught: readiness startup diagnostics reveal credential or certificate paths.
    const secretPath = '/operator/private/restore-client.p12';
    expect(() => readinessConnectionConfig(
      `mysql://probe:secret@localhost/db?sslidentity=${encodeURIComponent(secretPath)}`,
      125
    )).toThrowError('Invalid database TLS configuration');
    try {
      readinessConnectionConfig(
        `mysql://probe:secret@localhost/db?sslidentity=${encodeURIComponent(secretPath)}`,
        125
      );
    } catch (error) {
      expect(String(error)).not.toContain(secretPath);
    }
  });
});
