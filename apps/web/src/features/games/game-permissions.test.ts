import type { AuthUserContract, GameSnapshotDto } from '@poker/contracts';
import { expect, it } from 'vitest';
import { canManageGameLifecycle } from './game-permissions.js';

type Actor = Pick<AuthUserContract, 'id' | 'role'>;

const game: Pick<GameSnapshotDto, 'createdById'> = { createdById: 'creator-1' };

it.each([
  ['ADMIN', { id: 'admin-1', role: 'ADMIN' }, true],
  ['SUPER_ADMIN', { id: 'super-admin-1', role: 'SUPER_ADMIN' }, true],
  ['creator', { id: 'creator-1', role: 'USER' }, true],
  ['other user', { id: 'other-user-1', role: 'USER' }, false],
  ['no session', null, false]
] as const)('shows lifecycle controls to %s only when allowed', (_caseName, actor: Actor | null, expected) => {
  // Break caught: an owner cannot see lifecycle controls, or a non-owner user can see controls for another player's game.
  expect(canManageGameLifecycle(actor, game)).toBe(expected);
});
