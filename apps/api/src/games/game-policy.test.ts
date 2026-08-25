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
