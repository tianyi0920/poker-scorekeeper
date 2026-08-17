import type { Prisma, Role, User } from '../generated/prisma/client.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { forbidden } from '../common/errors/app-error.js';

export interface ManagedUser {
  id: string;
  role: Role;
}

export type UserManagementChange =
  | { operation: 'create'; role: Role }
  | {
      operation: 'update';
      role?: Role;
      isActive?: boolean;
      nickname?: string;
      rakeEnabled?: boolean;
    }
  | { operation: 'delete' | 'restore' }
  | { operation: 'reset-password' | 'reset-avatar' };

export function assertCanManageUser(
  actor: AuthUser,
  target: ManagedUser | null,
  change: UserManagementChange
): void {
  if (actor.role === 'SUPER_ADMIN') return;
  if (actor.role !== 'ADMIN') throw forbidden('FORBIDDEN');

  if (change.operation === 'create' && change.role === 'USER') return;
  if (
    change.operation === 'update' &&
    target?.role === 'USER' &&
    change.role === undefined &&
    change.isActive === undefined
  ) return;
  if (
    (change.operation === 'reset-password' || change.operation === 'reset-avatar') &&
    target?.role === 'USER'
  ) return;
  throw forbidden('FORBIDDEN');
}

export async function lockUsersInOrder(
  transaction: Prisma.TransactionClient,
  ids: readonly string[]
): Promise<Map<string, User>> {
  const orderedIds = [...new Set(ids)].sort();
  for (const id of orderedIds) {
    await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM users WHERE id = ${id} FOR UPDATE
    `;
  }
  const users = await transaction.user.findMany({ where: { id: { in: orderedIds } } });
  return new Map(users.map((user) => [user.id, user]));
}

export function requireCurrentActor(users: ReadonlyMap<string, User>, actorId: string): User {
  const actor = users.get(actorId);
  if (actor === undefined || !actor.isActive || actor.deletedAt !== null) {
    throw forbidden('FORBIDDEN');
  }
  return actor;
}
