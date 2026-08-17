import type { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import request, { type Response } from 'supertest';
import { AvatarKind, Role, type User } from '../src/generated/prisma/client.js';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const runId = randomUUID().replaceAll('-', '').slice(0, 10);
const prefix = `audit-${runId}`;
const password = `${randomBytes(18).toString('base64url')}Aa1!`;
const replacementPassword = `${randomBytes(18).toString('base64url')}Bb2!`;

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

describe.sequential('user administration audit trail', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let passwordHash: string;
  let actor: User;
  let auth: AuthContext;
  let targetId: string | undefined;

  async function login(target: User): Promise<AuthContext> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: target.username, password })
      .expect(201);
    return { cookie: cookieFrom(response), csrfToken: response.body.csrfToken };
  }

  function write(method: 'post' | 'patch' | 'delete', path: string, body?: object) {
    let call = request(app.getHttpServer())[method](path)
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrfToken);
    if (body !== undefined) call = call.send(body);
    return call;
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
    passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const username = `${prefix}-actor`;
    actor = await prisma.user.create({
      data: {
        username,
        normalizedUsername: normalize(username),
        nickname: `审计员-${runId}`,
        activeNormalizedNickname: normalize(`审计员-${runId}`),
        passwordHash,
        role: Role.SUPER_ADMIN,
        avatarValue: 'preset-01'
      }
    });
    auth = await login(actor);
  }, 30_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      const owned = await prisma.user.findMany({
        where: { normalizedUsername: { startsWith: normalize(prefix) } },
        select: { id: true }
      });
      const ids = owned.map(({ id }) => id);
      if (ids.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { OR: [{ actorUserId: { in: ids } }, { entityId: { in: ids } }] }
        });
        await prisma.authSession.deleteMany({ where: { userId: { in: ids } } });
        await prisma.user.deleteMany({ where: { id: { in: ids } } });
      }
    }
    if (app !== undefined) await app.close();
  }, 30_000);

  it('audits create, profile/rake/role/active updates, password reset, avatar reset, delete, and restore', async () => {
    const targetUsername = `${prefix}-target`;
    const created = await write('post', '/api/users', {
      username: targetUsername,
      nickname: `目标-${runId}`,
      initialPassword: password,
      role: 'USER',
      rakeEnabled: true
    }).expect(201);
    targetId = created.body.id;
    const initialTargetHash = (await prisma.user.findUniqueOrThrow({
      where: { id: targetId },
      select: { passwordHash: true }
    })).passwordHash;

    await write('patch', `/api/users/${targetId}`, {
      nickname: `新昵称-${runId}`,
      rakeEnabled: false
    }).expect(200);
    await write('patch', `/api/users/${targetId}`, { role: 'ADMIN' }).expect(200);
    await write('patch', `/api/users/${targetId}`, { isActive: false }).expect(200);
    await write('patch', `/api/users/${targetId}`, { isActive: true }).expect(200);
    await write('post', `/api/users/${targetId}/reset-password`, {
      newPassword: replacementPassword
    }).expect(200);
    const replacementTargetHash = (await prisma.user.findUniqueOrThrow({
      where: { id: targetId },
      select: { passwordHash: true }
    })).passwordHash;
    await prisma.user.update({
      where: { id: targetId },
      data: { avatarKind: AvatarKind.PRESET, avatarValue: 'preset-09' }
    });
    await write('post', `/api/users/${targetId}/avatar/reset`).expect(200);
    await write('delete', `/api/users/${targetId}`).expect(200);
    await write('post', `/api/users/${targetId}/restore`).send({}).expect(200);

    const logs = await prisma.auditLog.findMany({
      where: { entityType: 'USER', entityId: targetId },
      orderBy: { createdAt: 'asc' }
    });
    expect(logs.map(({ action }) => action)).toEqual([
      'USER_CREATED',
      'USER_UPDATED',
      'USER_UPDATED',
      'USER_UPDATED',
      'USER_UPDATED',
      'USER_PASSWORD_RESET',
      'USER_AVATAR_RESET',
      'USER_DELETED',
      'USER_RESTORED'
    ]);
    expect(logs.every(({ actorUserId }) => actorUserId === actor.id)).toBe(true);
    expect(logs[0]).toMatchObject({ beforeJson: null, afterJson: { username: targetUsername } });
    expect(logs[1]).toMatchObject({
      beforeJson: { rakeEnabled: true },
      afterJson: { nickname: `新昵称-${runId}`, rakeEnabled: false }
    });
    expect(logs[6]).toMatchObject({
      beforeJson: { avatarKind: 'PRESET', avatarValue: 'preset-09' },
      afterJson: { avatarKind: 'PRESET', avatarValue: 'preset-01' }
    });
    expect(logs[7]).toMatchObject({ beforeJson: { deletedAt: null }, afterJson: { isActive: false } });
    expect(logs[8]).toMatchObject({ beforeJson: { isActive: false }, afterJson: { isActive: true } });

    const serialized = JSON.stringify(logs);
    for (const secret of [
      password,
      replacementPassword,
      passwordHash,
      initialTargetHash,
      replacementTargetHash
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toMatch(/passwordHash|tokenHash|databaseUrl|cookieHeader/i);
    expect(serialized.toLowerCase()).not.toContain('mysql://');
    expect(serialized).not.toContain('poker_session');
  }, 30_000);
});
