import type { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import request, { type Response } from 'supertest';
import { rakeSettingsResponseSchema } from '@poker/contracts';
import { vi } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { Role, type User } from '../src/generated/prisma/client.js';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SettingsService } from '../src/settings/settings.service.js';

const runId = randomUUID().replaceAll('-', '').slice(0, 10);
const prefix = `settings-${runId}`;
const password = `${randomBytes(18).toString('base64url')}Aa1!`;

interface AuthContext {
  cookie: string;
  csrfToken: string;
}

function normalize(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}

function cookieFrom(response: Response): string {
  const header = response.headers['set-cookie'];
  const serialized = Array.isArray(header) ? header[0] : header;
  expect(serialized).toBeDefined();
  return serialized!.split(';', 1)[0]!;
}

describe.sequential('live rake settings', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let audit: AuditService;
  let settings: SettingsService;
  let passwordHash: string;
  let superUser: User;
  let adminUser: User;
  let regularUser: User;
  let superAuth: AuthContext;
  let adminAuth: AuthContext;
  let userAuth: AuthContext;

  async function seedUser(suffix: string, role: Role): Promise<User> {
    const username = `${prefix}-${suffix}`;
    const nickname = `设置-${runId}-${suffix}`;
    return prisma.user.create({
      data: {
        username,
        normalizedUsername: normalize(username),
        nickname,
        activeNormalizedNickname: normalize(nickname),
        passwordHash,
        role,
        avatarValue: 'preset-01'
      }
    });
  }

  async function login(target: User): Promise<AuthContext> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: target.username, password })
      .expect(201);
    return { cookie: cookieFrom(response), csrfToken: response.body.csrfToken };
  }

  function getRake(auth?: AuthContext) {
    const call = request(app.getHttpServer()).get('/api/settings/rake');
    return auth === undefined ? call : call.set('Cookie', auth.cookie);
  }

  function patchRake(auth: AuthContext, body: object) {
    return request(app.getHttpServer())
      .patch('/api/settings/rake')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrfToken)
      .send(body);
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.CSRF_SECRET = randomBytes(32).toString('hex');
    process.env.BOOTSTRAP_ADMIN_USERNAME = `${prefix}-bootstrap`;
    process.env.BOOTSTRAP_ADMIN_NICKNAME = `根-${runId}`;
    process.env.BOOTSTRAP_ADMIN_PASSWORD = password;

    app = await createApp();
    prisma = app.get(PrismaService);
    await app.init();
    audit = app.get(AuditService);
    settings = app.get(SettingsService);
    passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    superUser = await seedUser('super', Role.SUPER_ADMIN);
    adminUser = await seedUser('admin', Role.ADMIN);
    regularUser = await seedUser('user', Role.USER);
    superAuth = await login(superUser);
    adminAuth = await login(adminUser);
    userAuth = await login(regularUser);
  }, 30_000);

  beforeEach(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'SYSTEM_SETTING', entityId: 'singleton' } });
    await prisma.systemSetting.update({
      where: { id: 'singleton' },
      data: { rakeThreshold: 1000n, rakeBps: 1000, version: 1, updatedById: null }
    });
  });

  afterAll(async () => {
    if (prisma !== undefined) {
      const owned = await prisma.user.findMany({
        where: { normalizedUsername: { startsWith: normalize(prefix) } },
        select: { id: true }
      });
      const ids = owned.map(({ id }) => id);
      await prisma.systemSetting.update({
        where: { id: 'singleton' },
        data: { rakeThreshold: 1000n, rakeBps: 1000, version: 1, updatedById: null }
      });
      if (ids.length > 0) {
        await prisma.auditLog.deleteMany({ where: { actorUserId: { in: ids } } });
        await prisma.authSession.deleteMany({ where: { userId: { in: ids } } });
        await prisma.user.deleteMany({ where: { id: { in: ids } } });
      }
    }
    if (app !== undefined) await app.close();
  }, 30_000);

  it('requires authentication and lets every logged-in role read live settings', async () => {
    await getRake().expect(401).expect(({ body }) => expect(body.code).toBe('UNAUTHENTICATED'));

    for (const auth of [superAuth, adminAuth, userAuth]) {
      await getRake(auth).expect(200).expect(({ body }) => {
        expect(rakeSettingsResponseSchema.parse(body)).toEqual({
          threshold: '1000',
          bps: 1000,
          version: 1
        });
      });
    }
  });

  it.each([
    ['ADMIN', () => adminAuth],
    ['USER', () => userAuth]
  ] as const)('rejects %s updates without changing settings or auditing', async (_role, auth) => {
    await patchRake(auth(), { threshold: '1500', bps: 1250, version: 1 })
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('FORBIDDEN'));

    await expect(prisma.systemSetting.findUniqueOrThrow({ where: { id: 'singleton' } }))
      .resolves.toMatchObject({ rakeThreshold: 1000n, rakeBps: 1000, version: 1 });
    expect(await prisma.auditLog.count({ where: { action: 'RAKE_SETTINGS_UPDATED' } })).toBe(0);
  });

  it.each([
    [{ threshold: '-1', bps: 1000, version: 1 }, 'negative threshold'],
    [{ threshold: '01', bps: 1000, version: 1 }, 'non-canonical threshold'],
    [{ threshold: '1.5', bps: 1000, version: 1 }, 'fractional threshold'],
    [{ threshold: 1000, bps: 1000, version: 1 }, 'numeric threshold'],
    [{ threshold: '1000', bps: -1, version: 1 }, 'negative bps'],
    [{ threshold: '1000', bps: 10001, version: 1 }, 'bps above 10000'],
    [{ threshold: '1000', bps: 1.5, version: 1 }, 'fractional bps'],
    [{ threshold: '1000', bps: 1000, version: 0 }, 'non-positive version']
  ] as const)('rejects %s', async (body, label) => {
    await patchRake(superAuth, body)
      .expect(400)
      .expect(({ body: response }) => expect(response.code, label).toBe('VALIDATION_ERROR'));
  });

  it('accepts the signed BIGINT maximum threshold', async () => {
    await patchRake(superAuth, {
      threshold: '9223372036854775807',
      bps: 1000,
      version: 1
    })
      .expect(200)
      .expect(({ body }) => expect(body).toEqual({
        threshold: '9223372036854775807',
        bps: 1000,
        version: 2
      }));

    await expect(prisma.systemSetting.findUniqueOrThrow({ where: { id: 'singleton' } }))
      .resolves.toMatchObject({ rakeThreshold: 9223372036854775807n, version: 2 });
    expect(await prisma.auditLog.count({ where: { action: 'RAKE_SETTINGS_UPDATED' } })).toBe(1);
  });

  it('rejects a threshold above signed BIGINT without changing settings or auditing', async () => {
    await patchRake(superAuth, {
      threshold: '9223372036854775808',
      bps: 1000,
      version: 1
    })
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('VALIDATION_ERROR'));

    await expect(prisma.systemSetting.findUniqueOrThrow({ where: { id: 'singleton' } }))
      .resolves.toMatchObject({ rakeThreshold: 1000n, rakeBps: 1000, version: 1 });
    expect(await prisma.auditLog.count({ where: { action: 'RAKE_SETTINGS_UPDATED' } })).toBe(0);
  });

  it('increments the version and records actor, action, entity, before, and after', async () => {
    await patchRake(superAuth, { threshold: '1500', bps: 1250, version: 1 })
      .expect(200)
      .expect(({ body }) => expect(body).toEqual({ threshold: '1500', bps: 1250, version: 2 }));

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'RAKE_SETTINGS_UPDATED', entityId: 'singleton' }
    });
    expect(log).toMatchObject({
      actorUserId: superUser.id,
      action: 'RAKE_SETTINGS_UPDATED',
      entityType: 'SYSTEM_SETTING',
      entityId: 'singleton',
      beforeJson: { threshold: '1000', bps: 1000, version: 1 },
      afterJson: { threshold: '1500', bps: 1250, version: 2 }
    });
  });

  it('rejects a stale version without changing settings or appending an audit', async () => {
    await patchRake(superAuth, { threshold: '1500', bps: 1250, version: 2 })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('SETTINGS_VERSION_CONFLICT'));

    await expect(prisma.systemSetting.findUniqueOrThrow({ where: { id: 'singleton' } }))
      .resolves.toMatchObject({ rakeThreshold: 1000n, rakeBps: 1000, version: 1 });
    expect(await prisma.auditLog.count({ where: { action: 'RAKE_SETTINGS_UPDATED' } })).toBe(0);
  });

  it('allows exactly one of two updates using the same version', async () => {
    const responses = await Promise.all([
      patchRake(superAuth, { threshold: '1100', bps: 1100, version: 1 }),
      patchRake(superAuth, { threshold: '1200', bps: 1200, version: 1 })
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(await prisma.auditLog.count({ where: { action: 'RAKE_SETTINGS_UPDATED' } })).toBe(1);
    await expect(prisma.systemSetting.findUniqueOrThrow({ where: { id: 'singleton' } }))
      .resolves.toMatchObject({ version: 2 });
  });

  it('re-authorizes the actor inside the transaction after a concurrent demotion', async () => {
    const actor = await seedUser('race-super', Role.SUPER_ADMIN);
    let settingsLocked!: () => void;
    const locked = new Promise<void>((resolve) => { settingsLocked = resolve; });
    const blocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM system_settings WHERE id = 'singleton' FOR UPDATE
      `;
      settingsLocked();
      await transaction.user.update({ where: { id: actor.id }, data: { role: Role.ADMIN } });
    });
    await locked;
    const update = settings.updateRake(actor, { threshold: '1600', bps: 1600, version: 1 });

    try {
      await blocker;
      await expect(update).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(prisma.systemSetting.findUniqueOrThrow({ where: { id: 'singleton' } }))
        .resolves.toMatchObject({ rakeThreshold: 1000n, rakeBps: 1000, version: 1 });
      expect(await prisma.auditLog.count({ where: { action: 'RAKE_SETTINGS_UPDATED' } })).toBe(0);
    } finally {
      await prisma.user.update({ where: { id: actor.id }, data: { role: Role.SUPER_ADMIN } });
    }
  });

  it('rolls an audit record back with its surrounding database transaction', async () => {
    const entityId = `rollback-${runId}`;
    await expect(prisma.$transaction(async (transaction) => {
      await audit.record(transaction, {
        actorUserId: superUser.id,
        action: 'ROLLBACK_PROBE',
        entityType: 'TEST',
        entityId,
        before: null,
        after: { ok: true }
      });
      throw new Error('force rollback');
    })).rejects.toThrow('force rollback');

    expect(await prisma.auditLog.count({ where: { entityId } })).toBe(0);
  });

  it('sanitizes credential-shaped audit metadata before storage', async () => {
    const firstEntityId = `metadata-first-${runId}`;
    const secondEntityId = `metadata-second-${runId}`;
    const unsafeEntityId = `metadata-unsafe-${runId}`;
    const cyclic: Record<string, unknown> = { safe: true };
    cyclic.self = cyclic;
    const unreadable: Record<string, unknown> = {};
    Object.defineProperty(unreadable, 'safe', {
      enumerable: true,
      get() { throw new Error('getter must not escape'); }
    });
    const hostileProxy = new Proxy({}, {
      ownKeys() { throw new Error('proxy must not escape'); }
    });
    await prisma.$transaction(async (transaction) => {
      await audit.record(transaction, {
        actorUserId: superUser.id,
        action: 'METADATA_REDACTION_PROBE',
        entityType: 'TEST',
        entityId: firstEntityId,
        before: null,
        after: null,
        requestId: 'agent Authorization: Bearer request-token',
        sourceIp: 'Authorization: Basic basic-token',
        userAgent: 'User ID=db-user;Password=db-password;Server=db.example'
      });
      await audit.record(transaction, {
        actorUserId: superUser.id,
        action: 'METADATA_REDACTION_PROBE',
        entityType: 'TEST',
        entityId: secondEntityId,
        before: null,
        after: null,
        requestId: 'mysql://user:password@db.example/internal',
        sourceIp: 'agent Cookie: poker_session=cookie-token',
        userAgent: 'agent X-API-Key: api-key-token'
      });
      await audit.record(transaction, {
        actorUserId: superUser.id,
        action: 'METADATA_REDACTION_PROBE',
        entityType: 'TEST',
        entityId: unsafeEntityId,
        before: { cyclic, invalidDate: new Date('not-a-date'), unreadable, hostileProxy },
        after: null
      });
    });

    const logs = await prisma.auditLog.findMany({
      where: { entityId: { in: [firstEntityId, secondEntityId, unsafeEntityId] } },
      orderBy: { entityId: 'asc' }
    });
    expect(logs).toHaveLength(3);
    expect(logs[0]).toMatchObject({
      requestId: '[REDACTED]',
      sourceIp: '[REDACTED]',
      userAgent: '[REDACTED]'
    });
    expect(logs[1]).toMatchObject({
      requestId: '[REDACTED]',
      sourceIp: '[REDACTED]',
      userAgent: '[REDACTED]'
    });
    expect(logs[2]).toMatchObject({
      beforeJson: {
        cyclic: { safe: true, self: '[CIRCULAR]' },
        invalidDate: '[INVALID_DATE]',
        unreadable: { safe: '[UNREADABLE]' },
        hostileProxy: '[UNREADABLE]'
      }
    });
  });

  it('rolls a setting update back when audit storage fails and returns a fixed error', async () => {
    const injectedSecret = 'audit-storage-secret-marker';
    const record = vi.spyOn(audit, 'record')
      .mockRejectedValueOnce(new Error(injectedSecret));
    try {
      await patchRake(superAuth, { threshold: '1700', bps: 1700, version: 1 })
        .expect(500)
        .expect(({ body }) => {
          expect(body).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
          expect(JSON.stringify(body)).not.toContain(injectedSecret);
        });
    } finally {
      record.mockRestore();
    }

    await expect(prisma.systemSetting.findUniqueOrThrow({ where: { id: 'singleton' } }))
      .resolves.toMatchObject({ rakeThreshold: 1000n, rakeBps: 1000, version: 1 });
    expect(await prisma.auditLog.count({ where: { action: 'RAKE_SETTINGS_UPDATED' } })).toBe(0);
  });
});
