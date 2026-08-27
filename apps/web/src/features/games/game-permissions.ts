import type { AuthUserContract, GameSnapshotDto } from '@poker/contracts';

export function canManageGameLifecycle(
  actor: Pick<AuthUserContract, 'id' | 'role'> | null | undefined,
  game: Pick<GameSnapshotDto, 'createdById'>
): boolean {
  return actor !== null && actor !== undefined && (
    actor.role === 'ADMIN' ||
    actor.role === 'SUPER_ADMIN' ||
    actor.id === game.createdById
  );
}
