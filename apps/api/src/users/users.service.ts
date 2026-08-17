import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateUserRequest,
  RestoreUserRequest,
  ResetUserPasswordRequest,
  UpdateUserRequest,
  UserResponse
} from '@poker/contracts';
import type { AuthUser } from '../common/auth/auth-user.js';
import { conflict, notFound } from '../common/errors/app-error.js';
import { Prisma, type Role, type User } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../auth/password.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  assertCanManageUser,
  lockUsersInOrder,
  requireCurrentActor
} from './user-policy.js';
import { normalizeNickname, normalizeUsername } from './user-normalization.js';

const DEFAULT_AVATAR = 'preset-01';
const ROLE_RANK: Readonly<Record<Role, number>> = {
  USER: 0,
  ADMIN: 1,
  SUPER_ADMIN: 2
};

const publicUserSelect = {
  id: true,
  username: true,
  nickname: true,
  role: true,
  rakeEnabled: true,
  avatarKind: true,
  avatarValue: true,
  isActive: true,
  mustChangePassword: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.UserSelect;

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function toAuditUser(user: User | UserResponse): Record<string, unknown> {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    role: user.role,
    rakeEnabled: user.rakeEnabled,
    avatarKind: user.avatarKind,
    avatarValue: user.avatarValue,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    deletedAt: user.deletedAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(AuditService) private readonly audit: AuditService
  ) {}

  async list(): Promise<{ users: UserResponse[] }> {
    const users = await this.prisma.user.findMany({
      select: publicUserSelect,
      orderBy: [{ deletedAt: 'asc' }, { nickname: 'asc' }, { id: 'asc' }]
    });
    return { users };
  }

  async create(actor: AuthUser, input: CreateUserRequest): Promise<UserResponse> {
    const role = input.role as Role;
    const normalizedUsername = normalizeUsername(input.username);
    const activeNormalizedNickname = normalizeNickname(input.nickname);
    const passwordHash = await this.passwords.hash(input.initialPassword);

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const locked = await lockUsersInOrder(transaction, [actor.id]);
        const currentActor = requireCurrentActor(locked, actor.id);
        assertCanManageUser(currentActor, null, { operation: 'create', role });
        if (await transaction.user.findUnique({ where: { normalizedUsername } })) {
          throw conflict('USERNAME_TAKEN');
        }
        if (await transaction.user.findUnique({ where: { activeNormalizedNickname } })) {
          throw conflict('NICKNAME_TAKEN');
        }
        const created = await transaction.user.create({
          data: {
            username: input.username,
            normalizedUsername,
            nickname: input.nickname,
            activeNormalizedNickname,
            passwordHash,
            role,
            rakeEnabled: input.rakeEnabled,
            avatarValue: DEFAULT_AVATAR,
            mustChangePassword: true,
            createdById: currentActor.id
          },
          select: publicUserSelect
        });
        await this.audit.record(transaction, {
          actorUserId: currentActor.id,
          action: 'USER_CREATED',
          entityType: 'USER',
          entityId: created.id,
          before: null,
          after: toAuditUser(created)
        });
        return created;
      });
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
      if (await this.prisma.user.findUnique({ where: { normalizedUsername } })) {
        throw conflict('USERNAME_TAKEN');
      }
      throw conflict('NICKNAME_TAKEN');
    }
  }

  async update(
    actor: AuthUser,
    id: string,
    input: UpdateUserRequest
  ): Promise<UserResponse> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        if (input.role !== undefined || input.isActive !== undefined) {
          await this.lockLifecycleCoordinator(transaction);
        }
        const locked = await lockUsersInOrder(transaction, [actor.id, id]);
        const currentActor = requireCurrentActor(locked, actor.id);
        const target = locked.get(id) ?? null;
        if (target === null || target.deletedAt !== null) throw notFound('NOT_FOUND');
        const nextRole = input.role as Role | undefined;
        assertCanManageUser(currentActor, target, { operation: 'update', ...input, role: nextRole });

        const demoting = nextRole !== undefined && ROLE_RANK[nextRole] < ROLE_RANK[target.role];
        const disabling = target.isActive && input.isActive === false;
        if (demoting || disabling) {
          await this.assertLifecycleChangeAllowed(transaction, target);
        }

        const data: Prisma.UserUpdateInput = {
          ...(input.nickname === undefined ? {} : {
            nickname: input.nickname,
            activeNormalizedNickname: normalizeNickname(input.nickname)
          }),
          ...(nextRole === undefined ? {} : { role: nextRole }),
          ...(input.rakeEnabled === undefined ? {} : { rakeEnabled: input.rakeEnabled }),
          ...(input.isActive === undefined ? {} : { isActive: input.isActive })
        };
        const updated = await transaction.user.update({
          where: { id },
          data,
          select: publicUserSelect
        });
        if (nextRole !== undefined || input.isActive !== undefined) {
          await transaction.authSession.updateMany({
            where: { userId: id, revokedAt: null },
            data: { revokedAt: new Date() }
          });
        }
        await this.audit.record(transaction, {
          actorUserId: currentActor.id,
          action: 'USER_UPDATED',
          entityType: 'USER',
          entityId: updated.id,
          before: toAuditUser(target),
          after: toAuditUser(updated)
        });
        return updated;
      });
    } catch (error) {
      if (isUniqueConstraint(error)) throw conflict('NICKNAME_TAKEN');
      throw error;
    }
  }

  async softDelete(actor: AuthUser, id: string): Promise<UserResponse> {
    return this.prisma.$transaction(async (transaction) => {
      await this.lockLifecycleCoordinator(transaction);
      const locked = await lockUsersInOrder(transaction, [actor.id, id]);
      const currentActor = requireCurrentActor(locked, actor.id);
      const target = locked.get(id) ?? null;
      if (target === null || target.deletedAt !== null) throw notFound('NOT_FOUND');
      assertCanManageUser(currentActor, target, { operation: 'delete' });
      await this.assertLifecycleChangeAllowed(transaction, target);
      const now = new Date();
      const deleted = await transaction.user.update({
        where: { id },
        data: {
          isActive: false,
          activeNormalizedNickname: null,
          deletedAt: now
        },
        select: publicUserSelect
      });
      await transaction.authSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: now }
      });
      await this.audit.record(transaction, {
        actorUserId: currentActor.id,
        action: 'USER_DELETED',
        entityType: 'USER',
        entityId: deleted.id,
        before: toAuditUser(target),
        after: toAuditUser(deleted)
      });
      return deleted;
    });
  }

  async restore(actor: AuthUser, id: string, input: RestoreUserRequest): Promise<UserResponse> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const locked = await lockUsersInOrder(transaction, [actor.id, id]);
        const currentActor = requireCurrentActor(locked, actor.id);
        const target = locked.get(id) ?? null;
        if (target === null || target.deletedAt === null) throw notFound('NOT_FOUND');
        assertCanManageUser(currentActor, target, { operation: 'restore' });
        const nickname = input.nickname ?? target.nickname;
        const activeNormalizedNickname = normalizeNickname(nickname);
        if (await transaction.user.findUnique({ where: { activeNormalizedNickname } })) {
          throw conflict('NICKNAME_TAKEN');
        }
        const restored = await transaction.user.update({
          where: { id },
          data: { nickname, deletedAt: null, isActive: true, activeNormalizedNickname },
          select: publicUserSelect
        });
        await this.audit.record(transaction, {
          actorUserId: currentActor.id,
          action: 'USER_RESTORED',
          entityType: 'USER',
          entityId: restored.id,
          before: toAuditUser(target),
          after: toAuditUser(restored)
        });
        return restored;
      });
    } catch (error) {
      if (isUniqueConstraint(error)) throw conflict('NICKNAME_TAKEN');
      throw error;
    }
  }

  async resetPassword(
    actor: AuthUser,
    id: string,
    input: ResetUserPasswordRequest
  ): Promise<UserResponse> {
    const passwordHash = await this.passwords.hash(input.newPassword);
    const now = new Date();
    return this.prisma.$transaction(async (transaction) => {
      const locked = await lockUsersInOrder(transaction, [actor.id, id]);
      const currentActor = requireCurrentActor(locked, actor.id);
      const target = locked.get(id) ?? null;
      if (target === null || target.deletedAt !== null) throw notFound('NOT_FOUND');
      assertCanManageUser(currentActor, target, { operation: 'reset-password' });
      const updated = await transaction.user.update({
        where: { id },
        data: { passwordHash, mustChangePassword: true },
        select: publicUserSelect
      });
      await transaction.authSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: now }
      });
      await this.audit.record(transaction, {
        actorUserId: currentActor.id,
        action: 'USER_PASSWORD_RESET',
        entityType: 'USER',
        entityId: updated.id,
        before: toAuditUser(target),
        after: toAuditUser(updated)
      });
      return updated;
    });
  }

  private async assertLifecycleChangeAllowed(
    transaction: Prisma.TransactionClient,
    target: User
  ): Promise<void> {
    if (await transaction.activePlayerLock.findUnique({ where: { userId: target.id } })) {
      throw conflict('USER_IN_ACTIVE_GAME');
    }
    if (target.role === 'SUPER_ADMIN' && target.isActive && target.deletedAt === null) {
      const activeSuperCount = await transaction.user.count({
        where: { role: 'SUPER_ADMIN', isActive: true, deletedAt: null }
      });
      if (activeSuperCount <= 1) throw conflict('LAST_SUPER_ADMIN');
    }
  }

  private async lockLifecycleCoordinator(transaction: Prisma.TransactionClient): Promise<void> {
    await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM system_settings WHERE id = 'singleton' FOR UPDATE
    `;
  }
}
