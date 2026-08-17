import type { AvatarKind, Prisma, Role, User } from '../generated/prisma/client.js';
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

interface LockedUserRow {
  id: string;
  username: string;
  normalizedUsername: string;
  nickname: string;
  activeNormalizedNickname: string | null;
  passwordHash: string;
  role: Role;
  rakeEnabled: boolean | bigint | number;
  avatarKind: AvatarKind;
  avatarValue: string;
  isActive: boolean | bigint | number;
  mustChangePassword: boolean | bigint | number;
  createdById: string | null;
  deletedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

function databaseBoolean(value: boolean | bigint | number): boolean {
  return value === true || value === 1 || value === 1n;
}

function databaseDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapLockedUser(row: LockedUserRow): User {
  return {
    id: row.id,
    username: row.username,
    normalizedUsername: row.normalizedUsername,
    nickname: row.nickname,
    activeNormalizedNickname: row.activeNormalizedNickname,
    passwordHash: row.passwordHash,
    role: row.role,
    rakeEnabled: databaseBoolean(row.rakeEnabled),
    avatarKind: row.avatarKind,
    avatarValue: row.avatarValue,
    isActive: databaseBoolean(row.isActive),
    mustChangePassword: databaseBoolean(row.mustChangePassword),
    createdById: row.createdById,
    deletedAt: row.deletedAt === null ? null : databaseDate(row.deletedAt),
    createdAt: databaseDate(row.createdAt),
    updatedAt: databaseDate(row.updatedAt)
  };
}

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
  const users = new Map<string, User>();
  for (const id of orderedIds) {
    const rows = await transaction.$queryRaw<LockedUserRow[]>`
      SELECT
        id,
        username,
        normalized_username AS normalizedUsername,
        nickname,
        active_normalized_nickname AS activeNormalizedNickname,
        password_hash AS passwordHash,
        role,
        rake_enabled AS rakeEnabled,
        avatar_kind AS avatarKind,
        avatar_value AS avatarValue,
        is_active AS isActive,
        must_change_password AS mustChangePassword,
        created_by_id AS createdById,
        deleted_at AS deletedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM users
      WHERE id = ${id}
      FOR UPDATE
    `;
    const row = rows[0];
    if (row !== undefined) users.set(row.id, mapLockedUser(row));
  }
  return users;
}

export function requireCurrentActor(users: ReadonlyMap<string, User>, actorId: string): User {
  const actor = users.get(actorId);
  if (actor === undefined || !actor.isActive || actor.deletedAt !== null) {
    throw forbidden('FORBIDDEN');
  }
  return actor;
}
