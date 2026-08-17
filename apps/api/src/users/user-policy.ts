import type { Role } from '../generated/prisma/client.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { forbidden } from '../common/errors/app-error.js';

export interface ManagedUser {
  id: string;
  role: Role;
}

export type UserManagementChange =
  | { operation: 'create'; role: Role }
  | { operation: 'update'; role?: Role }
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
    (change.operation === 'reset-password' || change.operation === 'reset-avatar') &&
    target?.role === 'USER'
  ) return;
  throw forbidden('FORBIDDEN');
}
