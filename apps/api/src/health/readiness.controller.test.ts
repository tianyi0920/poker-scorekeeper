import type { ConfigService } from '@nestjs/config';
import { vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ReadinessController } from './readiness.controller.js';

describe('readiness timeout', () => {
  it('fails closed when the database probe does not settle before the configured bound', async () => {
    // Break caught: a stuck DB pool keeps readiness requests open indefinitely.
    vi.useFakeTimers();
    try {
      const prisma = {
        $queryRawUnsafe: () => new Promise<never>(() => undefined)
      } as unknown as PrismaService;
      const config = {
        get: (key: string) => key === 'READINESS_TIMEOUT_MS' ? '25' : undefined
      } as ConfigService;
      const controller = new ReadinessController(prisma, config);

      const result = controller.ready();
      const assertion = expect(result).rejects.toMatchObject({
        code: 'DATABASE_UNAVAILABLE',
        status: 503
      });
      await vi.advanceTimersByTimeAsync(26);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
