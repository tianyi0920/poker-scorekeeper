import type { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { setTimeout as delay } from 'node:timers/promises';
import request, { type Response } from 'supertest';
import { userResponseSchema } from '@poker/contracts';
import { GameStatus, Role, type User } from '../src/generated/prisma/client.js';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AvatarService } from '../src/uploads/avatar.service.js';
import { UsersService } from '../src/users/users.service.js';
import { requireAuthorizedTestDatabase } from './support/authorized-test-database.js';

requireAuthorizedTestDatabase();
const runId = randomUUID().replaceAll('-', '').slice(0, 10);
const prefix = `u${runId.slice(0, 6)}`;
const password = `${randomBytes(18).toString('base64url')}Aa1!`;
const replacementPassword = `${randomBytes(18).toString('base64url')}Bb2!`;

interface AuthContext {
  cookie: string;
  csrfToken: string;
}

function normalizeUsername(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}

function normalizeNickname(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function cookieFrom(response: Response): string {
  const header = response.headers['set-cookie'];
  const serialized = Array.isArray(header) ? header[0] : header;
  expect(serialized).toBeDefined();
  return serialized!.split(';', 1)[0]!;
}

describe.sequential('user administration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let passwordHash: string;
  let avatars: AvatarService;
  let usersService: UsersService;
  let superActor: User;
  let adminActor: User;
  let userActor: User;
  let superAuth: AuthContext;
  let adminAuth: AuthContext;
  let nicknameSequence = 0;

  function nextNickname(): string {
    nicknameSequence += 1;
    return `昵称${runId.slice(0, 6)}${nicknameSequence}`;
  }

  async function seedUser(
    suffix: string,
    role: Role = Role.USER,
    overrides: Partial<Pick<User, 'id' | 'isActive' | 'deletedAt' | 'mustChangePassword'>> = {}
  ): Promise<User> {
    const username = `${prefix}-${suffix}`;
    const nickname = nextNickname();
    return prisma.user.create({
      data: {
        username,
        normalizedUsername: normalizeUsername(username),
        nickname,
        activeNormalizedNickname: overrides.deletedAt === undefined
          ? normalizeNickname(nickname)
          : null,
        passwordHash,
        role,
        avatarValue: 'preset-01',
        ...overrides
      }
    });
  }

  async function login(user: User): Promise<AuthContext> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: user.username, password })
      .expect(201);
    return { cookie: cookieFrom(response), csrfToken: response.body.csrfToken };
  }

  function createUserAs(
    actor: AuthContext,
    body: {
      username: string;
      nickname: string;
      role: 'SUPER_ADMIN' | 'ADMIN' | 'USER';
      initialPassword?: string;
      rakeEnabled?: boolean;
    }
  ) {
    return request(app.getHttpServer())
      .post('/api/users')
      .set('Cookie', actor.cookie)
      .set('X-CSRF-Token', actor.csrfToken)
      .send({ initialPassword: password, ...body });
  }

  function patchUserAs(actor: AuthContext, id: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .patch(`/api/users/${id}`)
      .set('Cookie', actor.cookie)
      .set('X-CSRF-Token', actor.csrfToken)
      .send(body);
  }

  function deleteUserAs(actor: AuthContext, id: string) {
    return request(app.getHttpServer())
      .delete(`/api/users/${id}`)
      .set('Cookie', actor.cookie)
      .set('X-CSRF-Token', actor.csrfToken);
  }

  function restoreUserAs(actor: AuthContext, id: string, body: Record<string, unknown> = {}) {
    return request(app.getHttpServer())
      .post(`/api/users/${id}/restore`)
      .set('Cookie', actor.cookie)
      .set('X-CSRF-Token', actor.csrfToken)
      .send(body);
  }

  async function duringActorChange<T>(
    actorId: string,
    data: { role?: Role; isActive?: boolean },
    action: () => Promise<T>
  ): Promise<PromiseSettledResult<T>> {
    let rowLocked!: () => void;
    const locked = new Promise<void>((resolve) => { rowLocked = resolve; });
    const blocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM users WHERE id = ${actorId} FOR UPDATE
      `;
      rowLocked();
      await delay(1_500);
      await transaction.user.update({ where: { id: actorId }, data });
    }, { timeout: 10_000, maxWait: 5_000 });
    await locked;
    const result = action().then(
      (value): PromiseFulfilledResult<T> => ({ status: 'fulfilled', value }),
      (reason: unknown): PromiseRejectedResult => ({ status: 'rejected', reason })
    );
    await blocker;
    return result;
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.CSRF_SECRET = randomBytes(32).toString('hex');
    process.env.BOOTSTRAP_ADMIN_USERNAME = `${prefix}-bootstrap`;
    process.env.BOOTSTRAP_ADMIN_NICKNAME = `根${runId.slice(0, 6)}`;
    process.env.BOOTSTRAP_ADMIN_PASSWORD = password;

    app = await createApp();
    prisma = app.get(PrismaService);
    await app.init();
    avatars = app.get(AvatarService);
    usersService = app.get(UsersService);
    passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const bootstrapped = await prisma.user.findUnique({
      where: { normalizedUsername: normalizeUsername(`${prefix}-bootstrap`) }
    });
    superActor = bootstrapped === null
      ? await seedUser('super-actor', Role.SUPER_ADMIN)
      : await prisma.user.update({
          where: { id: bootstrapped.id },
          data: { mustChangePassword: false }
        });
    adminActor = await seedUser('admin-actor', Role.ADMIN);
    userActor = await seedUser('user-actor');
    superAuth = await login(superActor);
    adminAuth = await login(adminActor);
  }, 120_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      const owned = await prisma.user.findMany({
        where: { normalizedUsername: { startsWith: normalizeUsername(prefix) } },
        select: { id: true }
      });
      const ids = owned.map(({ id }) => id);
      if (ids.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { OR: [{ actorUserId: { in: ids } }, { entityId: { in: ids } }] }
        });
        await prisma.activePlayerLock.deleteMany({ where: { userId: { in: ids } } });
        await prisma.gamePlayer.deleteMany({ where: { userId: { in: ids } } });
        await prisma.game.deleteMany({ where: { createdById: { in: ids } } });
        await prisma.authSession.deleteMany({ where: { userId: { in: ids } } });
        await prisma.user.deleteMany({ where: { id: { in: ids } } });
      }
    }
    if (app !== undefined) await app.close();
  }, 120_000);

  it.each([
    ['ADMIN', 'ADMIN', 403],
    ['ADMIN', 'USER', 201],
    ['SUPER_ADMIN', 'ADMIN', 201]
  ] as const)('%s creating %s returns %s', async (actorRole, targetRole, status) => {
    const suffix = `${actorRole.toLowerCase()}-${targetRole.toLowerCase()}`;
    const actor = actorRole === 'SUPER_ADMIN' ? superAuth : adminAuth;
    const nickname = nextNickname();
    await createUserAs(actor, {
      username: `${prefix}-${suffix}`,
      nickname,
      role: targetRole
    })
      .expect(status)
      .then((response) => {
        if (status === 201) {
          expect(response.body).toMatchObject({
            username: `${prefix}-${suffix}`,
            nickname,
            role: targetRole,
            isActive: true,
            rakeEnabled: true,
            avatarKind: 'PRESET',
            avatarValue: 'preset-13'
          });
          expect(response.body).not.toHaveProperty('passwordHash');
        } else {
          expect(response.body.code).toBe('FORBIDDEN');
        }
      });
  });

  it('rejects ordinary users from the administration list', async () => {
    const userAuth = await login(userActor);
    await request(app.getHttpServer())
      .get('/api/users')
      .set('Cookie', userAuth.cookie)
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('FORBIDDEN'));
  });

  it('lists users for administrators without password material', async () => {
    await request(app.getHttpServer())
      .get('/api/users')
      .set('Cookie', adminAuth.cookie)
      .expect(200)
      .expect(({ body }) => {
        expect(body.users.some(({ id }: { id: string }) => id === adminActor.id)).toBe(true);
        expect(JSON.stringify(body)).not.toContain('passwordHash');
        for (const userResponse of body.users) userResponseSchema.parse(userResponse);
      });
  });

  it('rejects a normalized duplicate username permanently', async () => {
    const original = await seedUser('duplicate-name');
    await deleteUserAs(superAuth, original.id).expect(200);

    await createUserAs(adminAuth, {
      username: original.username.toUpperCase(),
      nickname: nextNickname(),
      role: 'USER'
    })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('USERNAME_TAKEN'));
  });

  it('allows a deleted nickname to be reused and preserves its game snapshot', async () => {
    const original = await seedUser('nickname-original');
    const game = await prisma.game.create({
      data: {
        name: `${prefix}-snapshot-game`,
        handPrice: 100n,
        status: GameStatus.COMPLETED,
        createdById: superActor.id
      }
    });
    const player = await prisma.gamePlayer.create({
      data: {
        gameId: game.id,
        userId: original.id,
        nicknameSnapshot: original.nickname,
        avatarKindSnapshot: original.avatarKind,
        avatarValueSnapshot: original.avatarValue,
        seatNo: 1,
        firstBuyinAt: new Date()
      }
    });

    await deleteUserAs(superAuth, original.id).expect(200);
    await createUserAs(adminAuth, {
      username: `${prefix}-nickname-replacement`,
      nickname: original.nickname,
      role: 'USER'
    }).expect(201);

    await expect(prisma.gamePlayer.findUniqueOrThrow({ where: { id: player.id } }))
      .resolves.toMatchObject({ nicknameSnapshot: original.nickname });
  }, 15_000);

  it('rejects restoring a deleted user when its nickname has been taken', async () => {
    const original = await seedUser('restore-original');
    await deleteUserAs(superAuth, original.id).expect(200);
    await createUserAs(adminAuth, {
      username: `${prefix}-restore-replacement`,
      nickname: original.nickname,
      role: 'USER'
    }).expect(201);

    await restoreUserAs(superAuth, original.id)
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('NICKNAME_TAKEN'));
  });

  it('restores a deleted user with an alternative nickname after its old nickname was reused', async () => {
    const original = await seedUser('restore-renamed');
    await deleteUserAs(superAuth, original.id).expect(200);
    await createUserAs(adminAuth, {
      username: `${prefix}-restore-new`,
      nickname: original.nickname,
      role: 'USER'
    }).expect(201);
    const replacementNickname = nextNickname();

    await restoreUserAs(superAuth, original.id, { nickname: replacementNickname })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        id: original.id,
        nickname: replacementNickname,
        isActive: true,
        deletedAt: null
      }));
  });

  it('rejects deleting a player locked into an active game', async () => {
    const player = await seedUser('active-player');
    const game = await prisma.game.create({
      data: {
        name: `${prefix}-active-game`,
        handPrice: 100n,
        status: GameStatus.ACTIVE,
        createdById: superActor.id
      }
    });
    await prisma.activePlayerLock.create({ data: { userId: player.id, gameId: game.id } });

    await deleteUserAs(superAuth, player.id)
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('USER_IN_ACTIVE_GAME'));
  });

  it('rejects demoting an active-game administrator to user', async () => {
    const target = await seedUser('active-admin', Role.ADMIN);
    const game = await prisma.game.create({
      data: {
        name: `${prefix}-active-admin-game`,
        handPrice: 100n,
        status: GameStatus.ACTIVE,
        createdById: superActor.id
      }
    });
    await prisma.activePlayerLock.create({ data: { userId: target.id, gameId: game.id } });

    await patchUserAs(superAuth, target.id, { role: 'USER' })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('USER_IN_ACTIVE_GAME'));
  });

  it('does not disable a player when an active-game lock is inserted concurrently', async () => {
    const player = await seedUser('concurrent-active');
    const game = await prisma.game.create({
      data: {
        name: `${prefix}-concurrent-game`,
        handPrice: 100n,
        status: GameStatus.ACTIVE,
        createdById: superActor.id
      }
    });
    let rowLocked!: () => void;
    const locked = new Promise<void>((resolve) => { rowLocked = resolve; });
    const blocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM users WHERE id = ${player.id} FOR UPDATE
      `;
      rowLocked();
      await delay(2_000);
      await transaction.activePlayerLock.create({
        data: { userId: player.id, gameId: game.id }
      });
    }, { timeout: 10_000, maxWait: 5_000 });
    await locked;
    const updateResult = usersService.update(superActor, player.id, { isActive: false }).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    );

    await blocker;
    await expect(updateResult).resolves.toMatchObject({
      status: 'rejected',
      reason: { code: 'USER_IN_ACTIVE_GAME' }
    });
    await expect(prisma.user.findUniqueOrThrow({ where: { id: player.id } }))
      .resolves.toMatchObject({ isActive: true });
  }, 15_000);

  it('makes a game join waiting behind lifecycle change re-check the committed user state', async () => {
    const player = await seedUser('lifecycle-first');
    const game = await prisma.game.create({
      data: {
        name: `${prefix}-lifecycle-first-game`,
        handPrice: 100n,
        status: GameStatus.ACTIVE,
        createdById: superActor.id
      }
    });
    let changed!: () => void;
    let release!: () => void;
    const userChanged = new Promise<void>((resolve) => { changed = resolve; });
    const canCommit = new Promise<void>((resolve) => { release = resolve; });
    const lifecycle = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM system_settings WHERE id = 'singleton' FOR UPDATE
      `;
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM users WHERE id = ${player.id} FOR UPDATE
      `;
      await transaction.user.update({ where: { id: player.id }, data: { isActive: false } });
      changed();
      await canCommit;
    }, { timeout: 10_000, maxWait: 5_000 });
    await userChanged;

    const join = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM users WHERE id = ${player.id} FOR UPDATE
      `;
      const current = await transaction.user.findUniqueOrThrow({ where: { id: player.id } });
      if (!current.isActive || current.deletedAt !== null) return false;
      await transaction.activePlayerLock.create({ data: { userId: player.id, gameId: game.id } });
      return true;
    }, { timeout: 10_000, maxWait: 5_000 });
    release();

    await lifecycle;
    await expect(join).resolves.toBe(false);
    await expect(prisma.activePlayerLock.findUnique({ where: { userId: player.id } }))
      .resolves.toBeNull();
  });

  it('prevents deleting the last active super admin', async () => {
    const otherSupers = await prisma.user.findMany({
      where: {
        id: { not: superActor.id },
        role: Role.SUPER_ADMIN,
        isActive: true,
        deletedAt: null
      },
      select: { id: true }
    });
    try {
      await prisma.user.updateMany({
        where: { id: { in: otherSupers.map(({ id }) => id) } },
        data: { isActive: false }
      });
      await deleteUserAs(superAuth, superActor.id)
        .expect(409)
        .expect(({ body }) => expect(body.code).toBe('LAST_SUPER_ADMIN'));
    } finally {
      await prisma.user.updateMany({
        where: { id: { in: otherSupers.map(({ id }) => id) } },
        data: { isActive: true }
      });
    }
  });

  it('serializes lifecycle changes to different super admins without a database deadlock', async () => {
    const first = await seedUser('concurrent-super-a', Role.SUPER_ADMIN);
    const second = await seedUser('concurrent-super-b', Role.SUPER_ADMIN);
    try {
      const results = await Promise.allSettled([
        usersService.update(superActor, first.id, { isActive: false }),
        usersService.update(superActor, second.id, { isActive: false })
      ]);

      expect(results).toEqual([
        expect.objectContaining({ status: 'fulfilled' }),
        expect.objectContaining({ status: 'fulfilled' })
      ]);
      await expect(prisma.user.count({
        where: { role: Role.SUPER_ADMIN, isActive: true, deletedAt: null }
      })).resolves.toBeGreaterThanOrEqual(1);
    } finally {
      await prisma.user.updateMany({
        where: { id: { in: [first.id, second.id] } },
        data: { isActive: true }
      });
    }
  });

  it('completes a lifecycle change and crossed avatar reset without a database deadlock', async () => {
    const idSuffix = runId.padEnd(29, '0');
    const resetActor = await seedUser('cross-lock-s2', Role.SUPER_ADMIN, {
      id: `1${idSuffix}`
    });
    const lifecycleActor = await seedUser('cross-lock-a', Role.SUPER_ADMIN, {
      id: `2${idSuffix}`
    });
    const lifecycleTarget = await seedUser('cross-lock-s1', Role.SUPER_ADMIN, {
      id: `3${idSuffix}`
    });
    let releaseTarget!: () => void;
    let targetLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseTarget = resolve; });
    const locked = new Promise<void>((resolve) => { targetLocked = resolve; });
    const blocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM users WHERE id = ${lifecycleTarget.id} FOR UPDATE
      `;
      targetLocked();
      await release;
    }, { timeout: 15_000, maxWait: 5_000 });
    await locked;

    const lifecycle = usersService.update(lifecycleActor, lifecycleTarget.id, {
      isActive: false
    }).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    );
    await delay(750);
    const avatarReset = avatars.resetByAdministrator(resetActor, lifecycleActor.id).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    );
    await delay(750);
    releaseTarget();
    await blocker;

    await expect(Promise.all([lifecycle, avatarReset])).resolves.toEqual([
      expect.objectContaining({ status: 'fulfilled' }),
      expect.objectContaining({ status: 'fulfilled' })
    ]);
  }, 20_000);

  it('allows only a super admin to modify user role and active state', async () => {
    const target = await seedUser('super-edit-target');
    const changedNickname = nextNickname();
    await patchUserAs(adminAuth, target.id, { role: 'ADMIN' })
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('FORBIDDEN'));

    await patchUserAs(superAuth, target.id, {
      role: 'ADMIN',
      nickname: changedNickname,
      rakeEnabled: false
    })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        id: target.id,
        role: 'ADMIN',
        nickname: changedNickname,
        rakeEnabled: false
      }));
  });

  it('lets an administrator edit nickname and rake only for an ordinary user', async () => {
    const target = await seedUser('admin-edit-user');
    const changedNickname = nextNickname();
    await patchUserAs(adminAuth, target.id, {
      nickname: changedNickname,
      rakeEnabled: false
    })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        id: target.id,
        nickname: changedNickname,
        rakeEnabled: false,
        role: 'USER'
      }));
  });

  it.each([
    ['ordinary user role', () => seedUser('admin-edit-role'), { role: 'ADMIN' }],
    ['ordinary user active state', () => seedUser('admin-edit-active'), { isActive: false }],
    ['administrator nickname', () => seedUser('admin-edit-admin', Role.ADMIN), { nickname: '不可修改' }]
  ] as const)('rejects an administrator changing %s', async (_name, createTarget, body) => {
    const target = await createTarget();
    await patchUserAs(adminAuth, target.id, body)
      .expect(403)
      .expect(({ body: responseBody }) => expect(responseBody.code).toBe('FORBIDDEN'));
  });

  it('re-authorizes user creation after the administrator is disabled mid-request', async () => {
    const actor = await seedUser('create-race-actor', Role.ADMIN);
    const result = await duringActorChange(actor.id, { isActive: false }, () => usersService.create(actor, {
      username: `${prefix}-create-race-target`,
      nickname: nextNickname(),
      initialPassword: replacementPassword,
      role: 'USER',
      rakeEnabled: true
    }));
    expect(result).toMatchObject({ status: 'rejected', reason: { code: 'FORBIDDEN' } });
  }, 60_000);

  it('re-authorizes user update after the super admin is demoted mid-request', async () => {
    const actor = await seedUser('update-race-actor', Role.SUPER_ADMIN);
    const target = await seedUser('update-race-target');
    const result = await duringActorChange(actor.id, { role: Role.ADMIN }, () =>
      usersService.update(actor, target.id, { role: 'ADMIN' })
    );
    expect(result).toMatchObject({ status: 'rejected', reason: { code: 'FORBIDDEN' } });
  }, 60_000);

  it('re-authorizes password reset after the administrator is demoted mid-request', async () => {
    const actor = await seedUser('password-actor-race', Role.ADMIN);
    const target = await seedUser('password-actor-target');
    const result = await duringActorChange(actor.id, { role: Role.USER }, () =>
      usersService.resetPassword(actor, target.id, { newPassword: replacementPassword })
    );
    expect(result).toMatchObject({ status: 'rejected', reason: { code: 'FORBIDDEN' } });
  }, 60_000);

  it('forces password change after an administrator reset', async () => {
    const target = await seedUser('password-reset');
    await request(app.getHttpServer())
      .post(`/api/users/${target.id}/reset-password`)
      .set('Cookie', adminAuth.cookie)
      .set('X-CSRF-Token', adminAuth.csrfToken)
      .send({ newPassword: replacementPassword })
      .expect(200)
      .expect(({ body }) => expect(body.mustChangePassword).toBe(true));

    const changed = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(changed.mustChangePassword).toBe(true);
    expect(await argon2.verify(changed.passwordHash, replacementPassword)).toBe(true);
  }, 60_000);

  it('re-authorizes an administrator password reset after a concurrent promotion', async () => {
    const target = await seedUser('password-race');
    let rowLocked!: () => void;
    const locked = new Promise<void>((resolve) => { rowLocked = resolve; });
    const blocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM users WHERE id = ${target.id} FOR UPDATE
      `;
      rowLocked();
      await delay(2_000);
      await transaction.user.update({
        where: { id: target.id },
        data: { role: Role.ADMIN }
      });
    }, { timeout: 10_000, maxWait: 5_000 });
    await locked;
    const resetPromise = usersService.resetPassword(
      adminActor,
      target.id,
      { newPassword: replacementPassword }
    );

    await blocker;
    await expect(resetPromise).rejects.toMatchObject({ code: 'FORBIDDEN' });
  }, 60_000);

  it.each(['role', 'isActive'] as const)('revokes sessions after %s changes', async (field) => {
    const target = await seedUser(`session-${field}`);
    await login(target);
    await patchUserAs(
      superAuth,
      target.id,
      field === 'role' ? { role: 'ADMIN' } : { isActive: false }
    ).expect(200);

    expect(await prisma.authSession.count({
      where: { userId: target.id, revokedAt: null }
    })).toBe(0);
  });
});
