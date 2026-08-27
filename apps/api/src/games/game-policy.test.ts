import { expect, it } from 'vitest';
import * as gamePolicy from './game-policy.js';

it('allows a fifth open game and rejects a sixth', () => {
  // Break caught: create and start still enforce the former two-table limit.
  const policy = gamePolicy as typeof gamePolicy & {
    MAX_OPEN_GAMES?: number;
    canOpenAnotherGame?: (openCount: number) => boolean;
  };

  expect(policy.MAX_OPEN_GAMES).toBe(5);
  expect(policy.canOpenAnotherGame?.(4)).toBe(true);
  expect(policy.canOpenAnotherGame?.(5)).toBe(false);
});

it.each(['ADMIN', 'SUPER_ADMIN'] as const)('lets %s manage any game', (role) => {
  expect(() => gamePolicy.assertCanManageGameLifecycle(
    { id: 'admin', role },
    { createdById: 'someone-else' }
  )).not.toThrow();
});

it('lets a regular user manage only a game they created', () => {
  expect(() => gamePolicy.assertCanManageGameLifecycle(
    { id: 'owner', role: 'USER' },
    { createdById: 'owner' }
  )).not.toThrow();
  expect(() => gamePolicy.assertCanManageGameLifecycle(
    { id: 'outsider', role: 'USER' },
    { createdById: 'owner' }
  )).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
});

it('keeps assertGameManager restricted to administrators', () => {
  expect(() => gamePolicy.assertGameManager({ role: 'USER' })).toThrowError(
    expect.objectContaining({ code: 'FORBIDDEN' })
  );
});
