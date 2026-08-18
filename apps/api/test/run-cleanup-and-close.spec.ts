import { describe, expect, it } from 'vitest';
import { runCleanupAndClose } from './support/run-cleanup-and-close.js';

describe('runCleanupAndClose', () => {
  it('still closes an initialized app when database cleanup fails', async () => {
    const cleanupError = new Error('cleanup failed');
    let closed = false;

    await expect(runCleanupAndClose(
      async () => { throw cleanupError; },
      async () => { closed = true; }
    )).rejects.toBe(cleanupError);
    expect(closed).toBe(true);
  });

  it('reports both errors when cleanup and app close fail', async () => {
    const cleanupError = new Error('cleanup failed');
    const closeError = new Error('close failed');

    const failure = await runCleanupAndClose(
      async () => { throw cleanupError; },
      async () => { throw closeError; }
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([cleanupError, closeError]);
  });
});
