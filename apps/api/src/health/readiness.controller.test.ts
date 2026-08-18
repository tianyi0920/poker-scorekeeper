import type { ConfigService } from '@nestjs/config';
import { MariaDbReadinessProbe, type ReadinessConnectionFactory } from './mariadb-readiness.probe.js';
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
          query: vi.fn(async () => {
            throw Object.assign(new Error('driver timeout with password=hidden'), { code: 'ETIMEDOUT' });
          }),
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
      expect.objectContaining({ connectTimeout: 25, socketTimeout: 25, queryTimeout: 25 }),
      expect.objectContaining({ connectTimeout: 25, socketTimeout: 25, queryTimeout: 25 })
    ]);
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
});
