import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import request, { type Response } from 'supertest';
import type { RequestWithAuth } from '../src/common/auth/auth-user.js';
import { ROLES_KEY } from '../src/common/auth/roles.decorator.js';
import { RolesGuard } from '../src/common/auth/roles.guard.js';
import { SessionGuard } from '../src/common/auth/session.guard.js';
import { AvatarKind, Role, type User } from '../src/generated/prisma/client.js';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SessionService } from '../src/auth/session.service.js';
import { BootstrapAdminService } from '../src/auth/bootstrap-admin.service.js';
import { PasswordService } from '../src/auth/password.service.js';
import {
  TEST_DATABASE_TARGET_REFUSED,
  requireAuthorizedTestDatabase
} from './support/authorized-test-database.js';

const SESSION_COOKIE_NAME = 'poker_session';
const runId = randomUUID().replaceAll('-', '').slice(0, 10);
const usernamePrefix = `auth-${runId}`;
const fixturePassword = `${randomBytes(18).toString('base64url')}Aa1!`;
const changedPassword = `${randomBytes(18).toString('base64url')}Bb2!`;
const bootstrapPassword = `${randomBytes(18).toString('base64url')}Cc3!`;
const csrfSecret = randomBytes(32).toString('hex');
const originalTestOnlyBootstrapUsername = process.env.TEST_ONLY_BOOTSTRAP_USERNAME;

type SeedName = 'forced' | 'standard' | 'wrong' | 'disabled' | 'deleted' | 'change' | 'logout' | 'throttle';

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

requireAuthorizedTestDatabase();

let sentinelPrisma: PrismaService;
let sentinelSuperAdmin: User;
let sentinelUpdatedAt: Date;

beforeAll(async () => {
  sentinelPrisma = new PrismaService(new ConfigService({
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: 'test'
  }));
  const passwordHash = await argon2.hash(fixturePassword, { type: argon2.argon2id });
  const username = `sentinel-auth-${runId}`;
  sentinelSuperAdmin = await sentinelPrisma.user.create({
    data: {
      username,
      normalizedUsername: normalized(username),
      nickname: `sentinel-auth-${runId}`,
      activeNormalizedNickname: normalized(`sentinel-auth-${runId}`),
      passwordHash,
      role: Role.SUPER_ADMIN,
      avatarValue: 'default'
    }
  });
  sentinelUpdatedAt = sentinelSuperAdmin.updatedAt;
});

afterAll(async () => {
  try {
    const sentinelAfterSuite = await sentinelPrisma.user.findUniqueOrThrow({
      where: { id: sentinelSuperAdmin.id }
    });
    expect(sentinelAfterSuite).toMatchObject({
      role: Role.SUPER_ADMIN,
      isActive: true,
      deletedAt: null
    });
    expect(sentinelAfterSuite.updatedAt.getTime()).toBe(sentinelUpdatedAt.getTime());
  } finally {
    await sentinelPrisma.authSession.deleteMany({ where: { userId: sentinelSuperAdmin.id } });
    await sentinelPrisma.user.delete({ where: { id: sentinelSuperAdmin.id } });
    await sentinelPrisma.$disconnect();
  }
});

function serializedCookieFrom(response: Response): string {
  const setCookie = response.headers['set-cookie'];
  expect(setCookie).toBeDefined();
  const serialized = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(serialized).toBeDefined();
  return serialized!;
}

function cookieFrom(response: Response): string {
  return serializedCookieFrom(response).split(';', 1)[0]!;
}

function cookieExpiresAt(serializedCookie: string): number {
  const match = /(?:^|; )Expires=([^;]+)/.exec(serializedCookie);
  expect(match).not.toBeNull();
  return new Date(match![1]!).getTime();
}

function rawTokenFrom(cookie: string): string {
  const prefix = `${SESSION_COOKIE_NAME}=`;
  expect(cookie.startsWith(prefix)).toBe(true);
  return cookie.slice(prefix.length);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function guardContext(
  authRequest: RequestWithAuth,
  handler: () => void = () => undefined,
  controller: abstract new (...args: never[]) => unknown = class {}
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => authRequest, getResponse: () => ({}) })
  } as unknown as ExecutionContext;
}

describe.sequential('session authentication', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let passwordHash: string;
  let users: Record<SeedName, User>;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.CSRF_SECRET = csrfSecret;
    process.env.BOOTSTRAP_ADMIN_USERNAME = `${usernamePrefix}-bootstrap`;
    process.env.BOOTSTRAP_ADMIN_NICKNAME = `${usernamePrefix}-root`;
    process.env.BOOTSTRAP_ADMIN_PASSWORD = bootstrapPassword;
    process.env.TEST_ONLY_BOOTSTRAP_USERNAME = normalized(`${usernamePrefix}-bootstrap`);

    app = await createApp();
    prisma = app.get(PrismaService);
    await app.init();
    passwordHash = await argon2.hash(fixturePassword, { type: argon2.argon2id });

    const seed = async (
      name: SeedName,
      overrides: Partial<Pick<User, 'isActive' | 'deletedAt' | 'mustChangePassword' | 'role'>> = {}
    ): Promise<User> => {
      const username = `${usernamePrefix}-${name}`;
      return prisma.user.create({
        data: {
          username,
          normalizedUsername: normalized(username),
          nickname: `${usernamePrefix}-${name}`,
          activeNormalizedNickname: normalized(`${usernamePrefix}-${name}`),
          passwordHash,
          avatarValue: 'default',
          ...overrides
        }
      });
    };

    users = {
      forced: await seed('forced', { mustChangePassword: true }),
      standard: await seed('standard'),
      wrong: await seed('wrong'),
      disabled: await seed('disabled', { isActive: false }),
      deleted: await seed('deleted', { deletedAt: new Date() }),
      change: await seed('change', { mustChangePassword: true }),
      logout: await seed('logout'),
      throttle: await seed('throttle')
    };
  }, 30_000);

  afterAll(async () => {
    try {
      if (prisma !== undefined) {
        const ownedUsers = await prisma.user.findMany({
          where: { normalizedUsername: { startsWith: normalized(usernamePrefix) } },
          select: { id: true }
        });
        const ownedIds = ownedUsers.map(({ id }) => id);
        if (ownedIds.length > 0) {
          await prisma.authSession.deleteMany({ where: { userId: { in: ownedIds } } });
          await prisma.user.deleteMany({ where: { id: { in: ownedIds } } });
        }
      }
    } finally {
      restoreEnvironment('TEST_ONLY_BOOTSTRAP_USERNAME', originalTestOnlyBootstrapUsername);
      if (app !== undefined) await app.close();
    }
  }, 30_000);

  function login(user: User, password = fixturePassword) {
    return request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: user.username, password });
  }

  it('does not mutate an unrelated active super admin while bootstrapping its own fixture', async () => {
    await expect(prisma.user.findUniqueOrThrow({ where: { id: sentinelSuperAdmin.id } }))
      .resolves.toMatchObject({
        role: Role.SUPER_ADMIN,
        isActive: true,
        updatedAt: sentinelUpdatedAt
      });
  });

  it('refuses auth fixture access when the configured database is not a test database', () => {
    expect(() => requireAuthorizedTestDatabase({
      DATABASE_URL: 'mysql://localhost/poker_scorekeeper'
    }))
      .toThrow(TEST_DATABASE_TARGET_REFUSED);
  });

  it('logs in with an Argon2id password, stores only the token hash, and returns the forced-change state', async () => {
    const startedAt = Date.now();
    await prisma.user.update({
      where: { id: users.forced.id },
      data: { avatarKind: AvatarKind.PRESET, avatarValue: 'preset-13' }
    });
    const response = await login(users.forced).expect(201);
    const serializedCookie = serializedCookieFrom(response);
    const cookie = cookieFrom(response);
    const rawToken = rawTokenFrom(cookie);
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    expect(serializedCookie).toContain('HttpOnly');
    expect(serializedCookie).toContain('SameSite=Lax');
    expect(serializedCookie).toContain('Path=/');
    expect(serializedCookie).toContain('Max-Age=604800');
    expect(rawToken).toMatch(/^[a-f0-9]{64}$/);
    expect(response.body.csrfToken).toMatch(/^[a-f0-9]{64}$/);
    expect(response.body.user).toMatchObject({
      id: users.forced.id,
      username: users.forced.username,
      nickname: users.forced.nickname,
      role: 'USER',
      mustChangePassword: true,
      avatarKind: 'PRESET',
      avatarValue: 'preset-13'
    });

    const stored = await prisma.authSession.findUniqueOrThrow({ where: { tokenHash } });
    expect(stored.tokenHash).toBe(tokenHash);
    expect(stored.tokenHash).not.toBe(rawToken);
    expect(stored.expiresAt.getTime()).toBeGreaterThanOrEqual(startedAt + 7 * 24 * 60 * 60 * 1000 - 5_000);
    expect(stored.absoluteExpiresAt.getTime()).toBeGreaterThanOrEqual(startedAt + 30 * 24 * 60 * 60 * 1000 - 5_000);
  });

  it.each([
    ['wrong password', 'wrong' as const, `${randomBytes(12).toString('hex')}Wrong1!`],
    ['disabled user', 'disabled' as const, fixturePassword],
    ['deleted user', 'deleted' as const, fixturePassword]
  ])('rejects a %s without revealing account state', async (_name, userName, password) => {
    await login(users[userName], password)
      .then((response) => {
        expect(response.status).toBe(401);
        expect(response.body.code).toBe('INVALID_CREDENTIALS');
      });
  });

  it('rejects malformed login input with a stable validation code', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: '', password: '' })
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('VALIDATION_ERROR'));
  });

  it('returns the current database role and uploaded avatar on every authenticated request', async () => {
    const loginResponse = await login(users.standard).expect(201);
    const cookie = cookieFrom(loginResponse);

    await prisma.user.update({
      where: { id: users.standard.id },
      data: {
        role: Role.ADMIN,
        avatarKind: AvatarKind.UPLOAD,
        avatarValue: 'standard-current-upload.webp'
      }
    });

    await request(app.getHttpServer())
      .get('/api/auth/session')
      .set('Cookie', cookie)
      .expect(200)
      .expect(({ body }) => {
        expect(body.user.id).toBe(users.standard.id);
        expect(body.user.role).toBe('ADMIN');
        expect(body.user.avatarKind).toBe('UPLOAD');
        expect(body.user.avatarValue).toBe('standard-current-upload.webp');
        expect(body.csrfToken).toMatch(/^[a-f0-9]{64}$/);
      });
  });

  it('renews the same browser session cookie after authenticated activity', async () => {
    const loginResponse = await login(users.standard).expect(201);
    const cookie = cookieFrom(loginResponse);
    const rawToken = rawTokenFrom(cookie);
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const before = await prisma.authSession.findUniqueOrThrow({ where: { tokenHash } });
    await prisma.authSession.update({
      where: { id: before.id },
      data: { expiresAt: new Date(Date.now() + 60_000) }
    });

    const response = await request(app.getHttpServer())
      .get('/api/auth/session')
      .set('Cookie', cookie)
      .expect(200);
    const renewedCookie = serializedCookieFrom(response);

    expect(cookieFrom(response)).toBe(cookie);
    expect(renewedCookie).toContain('HttpOnly');
    expect(renewedCookie).toContain('SameSite=Lax');
    expect(renewedCookie).toContain('Path=/');
    expect(renewedCookie).not.toContain('Max-Age=');
    const after = await prisma.authSession.findUniqueOrThrow({ where: { tokenHash } });
    expect(cookieExpiresAt(renewedCookie)).toBe(
      Math.floor(after.expiresAt.getTime() / 1000) * 1000
    );
    expect(after.id).toBe(before.id);
    expect(after.tokenHash).toBe(before.tokenHash);
  });

  it('renews a browser cookie only up to the session absolute expiry', async () => {
    const loginResponse = await login(users.standard).expect(201);
    const cookie = cookieFrom(loginResponse);
    const rawToken = rawTokenFrom(cookie);
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const absoluteExpiresAt = new Date(Date.now() + 120_000);
    await prisma.authSession.update({
      where: { tokenHash },
      data: {
        expiresAt: new Date(Date.now() + 60_000),
        absoluteExpiresAt
      }
    });

    const response = await request(app.getHttpServer())
      .get('/api/auth/session')
      .set('Cookie', cookie)
      .expect(200);
    const renewedCookie = serializedCookieFrom(response);

    expect(cookieFrom(response)).toBe(cookie);
    expect(renewedCookie).not.toContain('Max-Age=');
    expect(cookieExpiresAt(renewedCookie)).toBeLessThanOrEqual(absoluteExpiresAt.getTime());
    const stored = await prisma.authSession.findUniqueOrThrow({ where: { tokenHash } });
    expect(stored.expiresAt.getTime()).toBeLessThanOrEqual(absoluteExpiresAt.getTime());
    expect(stored.tokenHash).toBe(tokenHash);
  });

  it('never serializes renewal expiry beyond the fixed absolute limit when the response clock advances', async () => {
    const loginResponse = await login(users.standard).expect(201);
    const cookie = cookieFrom(loginResponse);
    const rawToken = rawTokenFrom(cookie);
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const absoluteExpiresAt = new Date(Math.ceil((Date.now() + 120_000) / 1000) * 1000);
    await prisma.authSession.update({
      where: { tokenHash },
      data: {
        expiresAt: new Date(Date.now() + 60_000),
        absoluteExpiresAt
      }
    });
    interface ExpressResponsePrototype {
      cookie(
        this: ExpressResponsePrototype,
        name: string,
        value: string,
        options: Record<string, unknown>
      ): ExpressResponsePrototype;
    }
    const expressApp = app.getHttpAdapter().getInstance() as {
      response: ExpressResponsePrototype;
    };
    const originalCookie = expressApp.response.cookie;
    expressApp.response.cookie = function (name, value, options) {
      const now = vi.spyOn(Date, 'now').mockReturnValue(absoluteExpiresAt.getTime() + 2_000);
      try {
        return originalCookie.call(this, name, value, options);
      } finally {
        now.mockRestore();
      }
    };

    let response: Response;
    try {
      response = await request(app.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', cookie)
        .expect(200);
    } finally {
      expressApp.response.cookie = originalCookie;
    }
    const renewedCookie = serializedCookieFrom(response);

    expect(cookieFrom(response)).toBe(cookie);
    expect(cookieExpiresAt(renewedCookie)).toBeLessThanOrEqual(absoluteExpiresAt.getTime());
  });

  it('rejects an expired session from the real session table', async () => {
    const rawToken = randomBytes(32).toString('hex');
    const cookie = `${SESSION_COOKIE_NAME}=${rawToken}`;
    await prisma.authSession.create({
      data: {
        userId: users.standard.id,
        tokenHash: createHash('sha256').update(rawToken).digest('hex'),
        expiresAt: new Date(Date.now() - 1_000),
        absoluteExpiresAt: new Date(Date.now() + 60_000),
        lastSeenAt: new Date(Date.now() - 2_000),
        ipAddress: '127.0.0.1',
        userAgent: 'auth-e2e'
      }
    });

    await request(app.getHttpServer())
      .get('/api/auth/session')
      .set('Cookie', cookie)
      .expect(401)
      .expect(({ body }) => expect(body.code).toBe('UNAUTHENTICATED'));
  });

  it('rejects a session past its absolute lifetime even when its idle expiry is future', async () => {
    const rawToken = randomBytes(32).toString('hex');
    const cookie = `${SESSION_COOKIE_NAME}=${rawToken}`;
    await prisma.authSession.create({
      data: {
        userId: users.standard.id,
        tokenHash: createHash('sha256').update(rawToken).digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
        absoluteExpiresAt: new Date(Date.now() - 1_000),
        lastSeenAt: new Date(Date.now() - 2_000),
        ipAddress: '127.0.0.1',
        userAgent: 'auth-e2e'
      }
    });

    await request(app.getHttpServer())
      .get('/api/auth/session')
      .set('Cookie', cookie)
      .expect(401)
      .expect(({ body }) => expect(body.code).toBe('UNAUTHENTICATED'));
  });

  it('rejects a session as soon as its user is disabled', async () => {
    const loginResponse = await login(users.logout).expect(201);
    const cookie = cookieFrom(loginResponse);
    await prisma.user.update({ where: { id: users.logout.id }, data: { isActive: false } });

    await request(app.getHttpServer())
      .get('/api/auth/session')
      .set('Cookie', cookie)
      .expect(401)
      .expect(({ body }) => expect(body.code).toBe('UNAUTHENTICATED'));

    await prisma.user.update({ where: { id: users.logout.id }, data: { isActive: true } });
  });

  it('rejects an unsafe authenticated request without the matching csrf token', async () => {
    const loginResponse = await login(users.logout).expect(201);
    const cookie = cookieFrom(loginResponse);
    const rawToken = rawTokenFrom(cookie);
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Cookie', cookie)
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('CSRF_INVALID'));

    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', '0'.repeat(64))
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('CSRF_INVALID'));

    const stored = await prisma.authSession.findUniqueOrThrow({ where: { tokenHash } });
    expect(stored.revokedAt).toBeNull();
  });

  it('logs out only with csrf, revokes the database session, and expires the cookie', async () => {
    const loginResponse = await login(users.logout).expect(201);
    const cookie = cookieFrom(loginResponse);
    const rawToken = rawTokenFrom(cookie);
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    const logoutResponse = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', loginResponse.body.csrfToken)
      .expect(200);

    const clearCookie = serializedCookieFrom(logoutResponse);
    expect(clearCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(clearCookie).toMatch(/(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/);
    await expect(prisma.authSession.findUniqueOrThrow({ where: { tokenHash } }))
      .resolves.toMatchObject({ revokedAt: expect.any(Date) });
    await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', cookie).expect(401);
  });

  it('changes the password, clears forced-change state, and revokes every other session', async () => {
    await prisma.user.update({
      where: { id: users.change.id },
      data: {
        avatarKind: AvatarKind.UPLOAD,
        avatarValue: 'change-password-upload.webp'
      }
    });
    const primaryLogin = await login(users.change).expect(201);
    const secondaryLogin = await login(users.change).expect(201);
    const primaryCookie = cookieFrom(primaryLogin);
    const secondaryCookie = cookieFrom(secondaryLogin);
    const primaryHash = createHash('sha256').update(rawTokenFrom(primaryCookie)).digest('hex');
    const secondaryHash = createHash('sha256').update(rawTokenFrom(secondaryCookie)).digest('hex');

    await request(app.getHttpServer())
      .post('/api/auth/change-password')
      .set('Cookie', primaryCookie)
      .set('X-CSRF-Token', primaryLogin.body.csrfToken)
      .send({ currentPassword: fixturePassword, newPassword: changedPassword })
      .expect(200)
      .expect(({ body }) => expect(body.user).toMatchObject({
        mustChangePassword: false,
        avatarKind: 'UPLOAD',
        avatarValue: 'change-password-upload.webp'
      }));

    const [updatedUser, primarySession, secondarySession] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: users.change.id } }),
      prisma.authSession.findUniqueOrThrow({ where: { tokenHash: primaryHash } }),
      prisma.authSession.findUniqueOrThrow({ where: { tokenHash: secondaryHash } })
    ]);
    expect(updatedUser.mustChangePassword).toBe(false);
    expect(await argon2.verify(updatedUser.passwordHash, changedPassword)).toBe(true);
    expect(primarySession.revokedAt).toBeNull();
    expect(secondarySession.revokedAt).toEqual(expect.any(Date));

    await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', secondaryCookie).expect(401);
    await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', primaryCookie).expect(200);
    await login(users.change, fixturePassword).then((response) => expect(response.status).toBe(401));
    await login(users.change, changedPassword).then((response) => expect(response.status).toBe(201));
  }, 15_000);

  it('blocks a forced-change session from non-authentication routes', async () => {
    const loginResponse = await login(users.forced).expect(201);
    const authRequest: RequestWithAuth = {
      method: 'GET',
      path: '/api/games/current',
      headers: { cookie: cookieFrom(loginResponse) }
    };

    await expect(app.get(SessionGuard).canActivate(guardContext(authRequest)))
      .rejects.toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
  });

  it('enforces role metadata against the actor attached by authentication', () => {
    class RestrictedController {}
    const handler = () => undefined;
    Reflect.defineMetadata(ROLES_KEY, [Role.ADMIN, Role.SUPER_ADMIN], handler);
    const authRequest: RequestWithAuth = {
      method: 'GET',
      path: '/api/admin/users',
      headers: {},
      user: {
        id: users.forced.id,
        username: users.forced.username,
        nickname: users.forced.nickname,
        role: Role.USER,
        mustChangePassword: false,
        avatarKind: 'PRESET',
        avatarValue: 'preset-01'
      }
    };
    const context = guardContext(authRequest, handler, RestrictedController);

    expect(() => app.get(RolesGuard).canActivate(context))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    authRequest.user = { ...authRequest.user!, role: Role.ADMIN };
    expect(app.get(RolesGuard).canActivate(context)).toBe(true);
  });

  it('creates the first super admin once with an Argon2id password', async () => {
    const bootstrap = await prisma.user.findUniqueOrThrow({
      where: { normalizedUsername: normalized(process.env.BOOTSTRAP_ADMIN_USERNAME!) }
    });
    expect(bootstrap.role).toBe(Role.SUPER_ADMIN);
    expect(bootstrap.avatarValue).toBe('preset-13');
    expect(bootstrap.mustChangePassword).toBe(true);
    expect(bootstrap.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(bootstrap.passwordHash, bootstrapPassword)).toBe(true);

    const secondApp = await createApp();
    await secondApp.init();
    await secondApp.close();

    await expect(prisma.user.count({
      where: { normalizedUsername: normalized(process.env.BOOTSTRAP_ADMIN_USERNAME!) }
    })).resolves.toBe(1);
  });

  it('serializes concurrent bootstrap calls using the same configuration', async () => {
    const concurrentUsername = `${usernamePrefix}-concurrent-same`;
    const makeService = (): BootstrapAdminService => new BootstrapAdminService(
      prisma,
      app.get(PasswordService),
      new ConfigService({
        NODE_ENV: 'test',
        DATABASE_URL: process.env.DATABASE_URL,
        BOOTSTRAP_ADMIN_USERNAME: concurrentUsername,
        BOOTSTRAP_ADMIN_NICKNAME: `${usernamePrefix}-concurrent-root`,
        BOOTSTRAP_ADMIN_PASSWORD: bootstrapPassword,
        TEST_ONLY_BOOTSTRAP_USERNAME: normalized(concurrentUsername)
      })
    );

    try {
      const results = await Promise.allSettled([
        makeService().onApplicationBootstrap(),
        makeService().onApplicationBootstrap()
      ]);

      expect(results.map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled']);
      await expect(prisma.user.count({
        where: { normalizedUsername: normalized(concurrentUsername) }
      })).resolves.toBe(1);
    } finally {
      await prisma.user.deleteMany({
        where: { normalizedUsername: normalized(concurrentUsername) }
      });
    }
  }, 15_000);

  it('rejects one of two concurrent test-only bootstrap calls with conflicting configurations', async () => {
    const concurrentUsername = `${usernamePrefix}-concurrent-conflict`;
    const makeService = (sequence: number): BootstrapAdminService =>
      new BootstrapAdminService(
        prisma,
        app.get(PasswordService),
        new ConfigService({
          NODE_ENV: 'test',
          DATABASE_URL: process.env.DATABASE_URL,
          BOOTSTRAP_ADMIN_USERNAME: concurrentUsername,
          BOOTSTRAP_ADMIN_NICKNAME: `${usernamePrefix}-concurrent-${sequence}`,
          BOOTSTRAP_ADMIN_PASSWORD: bootstrapPassword,
          TEST_ONLY_BOOTSTRAP_USERNAME: normalized(concurrentUsername)
        })
      );

    try {
      const results = await Promise.allSettled([
        makeService(1).onApplicationBootstrap(),
        makeService(2).onApplicationBootstrap()
      ]);

      expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
      await expect(prisma.user.count({
        where: { normalizedUsername: normalized(concurrentUsername) }
      })).resolves.toBe(1);
    } finally {
      await prisma.user.deleteMany({
        where: { normalizedUsername: normalized(concurrentUsername) }
      });
    }
  }, 15_000);

  it.each([
    ['outside test mode', {
      NODE_ENV: 'production',
      DATABASE_URL: process.env.DATABASE_URL
    }],
    ['outside a test database', {
      NODE_ENV: 'test',
      DATABASE_URL: 'mysql://localhost/poker_scorekeeper'
    }]
  ])('fails closed for test-only bootstrap %s', async (_case, environment) => {
    const target = `${usernamePrefix}-fail-closed-${randomUUID()}`;
    const service = new BootstrapAdminService(
      prisma,
      app.get(PasswordService),
      new ConfigService({
        ...environment,
        BOOTSTRAP_ADMIN_USERNAME: target,
        BOOTSTRAP_ADMIN_NICKNAME: target,
        BOOTSTRAP_ADMIN_PASSWORD: bootstrapPassword,
        TEST_ONLY_BOOTSTRAP_USERNAME: normalized(target)
      })
    );

    await expect(service.onApplicationBootstrap()).rejects.toThrow(/Test-only|test-only/);
    await expect(prisma.user.count({ where: { normalizedUsername: normalized(target) } }))
      .resolves.toBe(0);
  });

  it('does not override an existing super admin without the explicit test-only marker', async () => {
    const target = `${usernamePrefix}-missing-marker`;
    const service = new BootstrapAdminService(
      prisma,
      app.get(PasswordService),
      new ConfigService({
        NODE_ENV: 'test',
        DATABASE_URL: process.env.DATABASE_URL,
        BOOTSTRAP_ADMIN_USERNAME: target,
        BOOTSTRAP_ADMIN_NICKNAME: target,
        BOOTSTRAP_ADMIN_PASSWORD: bootstrapPassword,
        TEST_ONLY_BOOTSTRAP_USERNAME: ''
      })
    );

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    await expect(prisma.user.count({ where: { normalizedUsername: normalized(target) } }))
      .resolves.toBe(0);
  });

  it('fails closed when the test-only marker does not identify the configured username', async () => {
    const target = `${usernamePrefix}-marker-target`;
    const service = new BootstrapAdminService(
      prisma,
      app.get(PasswordService),
      new ConfigService({
        NODE_ENV: 'test',
        DATABASE_URL: process.env.DATABASE_URL,
        BOOTSTRAP_ADMIN_USERNAME: target,
        BOOTSTRAP_ADMIN_NICKNAME: target,
        BOOTSTRAP_ADMIN_PASSWORD: bootstrapPassword,
        TEST_ONLY_BOOTSTRAP_USERNAME: `${target}-different`
      })
    );

    await expect(service.onApplicationBootstrap())
      .rejects.toThrow('Test-only bootstrap target must match bootstrap username');
    await expect(prisma.user.count({ where: { normalizedUsername: normalized(target) } }))
      .resolves.toBe(0);
  });

  it('refuses production startup when no active super admin or complete bootstrap configuration exists', async () => {
    const environment = {
      nodeEnv: process.env.NODE_ENV,
      username: process.env.BOOTSTRAP_ADMIN_USERNAME,
      nickname: process.env.BOOTSTRAP_ADMIN_NICKNAME,
      password: process.env.BOOTSTRAP_ADMIN_PASSWORD
    };
    process.env.NODE_ENV = 'production';
    delete process.env.BOOTSTRAP_ADMIN_PASSWORD;

    try {
      expect(app.get(SessionService).cookieOptions().secure).toBe(true);
      const isolatedService = new BootstrapAdminService(
        {
          $transaction: async (operation: (transaction: unknown) => Promise<unknown>) => operation({
            $queryRaw: async () => [{ id: 'singleton' }],
            user: { count: async () => 0 }
          })
        } as unknown as PrismaService,
        app.get(PasswordService),
        new ConfigService({ NODE_ENV: 'production', TEST_ONLY_BOOTSTRAP_USERNAME: '' })
      );
      await expect(isolatedService.onApplicationBootstrap())
        .rejects.toThrow('Bootstrap super admin configuration is required');
    } finally {
      restoreEnvironment('NODE_ENV', environment.nodeEnv);
      restoreEnvironment('BOOTSTRAP_ADMIN_USERNAME', environment.username);
      restoreEnvironment('BOOTSTRAP_ADMIN_NICKNAME', environment.nickname);
      restoreEnvironment('BOOTSTRAP_ADMIN_PASSWORD', environment.password);
    }
  }, 15_000);

  it('throttles the eleventh failed login for the same account and source', async () => {
    const wrongPassword = `${randomBytes(12).toString('hex')}Wrong4!`;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await login(users.throttle, wrongPassword)
        .then((response) => {
          expect(response.status).toBe(401);
          expect(response.body.code).toBe('INVALID_CREDENTIALS');
        });
    }

    await login(users.throttle, wrongPassword)
      .then((response) => {
        expect(response.status).toBe(429);
        expect(response.body.code).toBe('TOO_MANY_REQUESTS');
      });
  });
});
