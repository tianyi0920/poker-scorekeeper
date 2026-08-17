import type { INestApplication } from '@nestjs/common';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import * as argon2 from 'argon2';
import sharp from 'sharp';
import request, { type Response } from 'supertest';
import { AvatarKind, GameStatus, Role, type User } from '../src/generated/prisma/client.js';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AvatarService } from '../src/uploads/avatar.service.js';

const runId = randomUUID().replaceAll('-', '').slice(0, 10);
const prefix = `avatars-${runId}`;
const password = `${randomBytes(18).toString('base64url')}Aa1!`;

interface AuthContext {
  cookie: string;
  csrfToken: string;
}

function normalized(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}

function cookieFrom(response: Response): string {
  const header = response.headers['set-cookie'];
  const serialized = Array.isArray(header) ? header[0] : header;
  expect(serialized).toBeDefined();
  return serialized!.split(';', 1)[0]!;
}

describe.sequential('avatar pipeline', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let avatarRoot: string;
  let legacyAvatarRoot: string;
  let passwordHash: string;
  let avatars: AvatarService;
  let user: User;
  let admin: User;
  let userAuth: AuthContext;
  let adminAuth: AuthContext;
  let validPng: Buffer;

  async function seedUser(suffix: string, role: Role): Promise<User> {
    const username = `${prefix}-${suffix}`;
    const nickname = `头像-${prefix}-${suffix}`;
    return prisma.user.create({
      data: {
        username,
        normalizedUsername: normalized(username),
        nickname,
        activeNormalizedNickname: normalized(nickname),
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

  function uploadAvatar(input: Buffer, filename = 'face.png', mimeType?: string) {
    let call = request(app.getHttpServer())
      .post('/api/me/avatar/upload')
      .set('Cookie', userAuth.cookie)
      .set('X-CSRF-Token', userAuth.csrfToken);
    call = mimeType === undefined
      ? call.attach('file', input, filename)
      : call.attach('file', input, { filename, contentType: mimeType });
    return call;
  }

  beforeAll(async () => {
    avatarRoot = await mkdtemp(join(tmpdir(), 'poker-avatar-e2e-'));
    legacyAvatarRoot = await mkdtemp(join(tmpdir(), 'poker-avatar-legacy-e2e-'));
    process.env.NODE_ENV = 'test';
    process.env.AVATAR_ROOT = avatarRoot;
    process.env.AVATAR_UPLOAD_ROOT = legacyAvatarRoot;
    process.env.CSRF_SECRET = randomBytes(32).toString('hex');
    process.env.BOOTSTRAP_ADMIN_USERNAME = `${prefix}-bootstrap`;
    process.env.BOOTSTRAP_ADMIN_NICKNAME = `头像-${prefix}-bootstrap`;
    process.env.BOOTSTRAP_ADMIN_PASSWORD = password;

    app = await createApp();
    prisma = app.get(PrismaService);
    await app.init();
    avatars = app.get(AvatarService);
    passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    user = await seedUser('user', Role.USER);
    admin = await seedUser('admin', Role.ADMIN);
    userAuth = await login(user);
    adminAuth = await login(admin);
    validPng = await sharp({
      create: { width: 420, height: 300, channels: 4, background: '#3b82f6' }
    }).png().toBuffer();
  }, 30_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      const owned = await prisma.user.findMany({
        where: { normalizedUsername: { startsWith: normalized(prefix) } },
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
    if (avatarRoot !== undefined) await rm(avatarRoot, { recursive: true, force: true });
    if (legacyAvatarRoot !== undefined) await rm(legacyAvatarRoot, { recursive: true, force: true });
  }, 30_000);

  it('returns twelve stable controlled preset identifiers', async () => {
    await request(app.getHttpServer())
      .get('/api/avatars/presets')
      .set('Cookie', userAuth.cookie)
      .expect(200)
      .expect(({ body }) => {
        expect(body.presets).toHaveLength(12);
        expect(body.presets[0]).toEqual({ id: 'preset-01', path: '/avatars/preset-01.webp' });
        expect(body.presets[11]).toEqual({ id: 'preset-12', path: '/avatars/preset-12.webp' });
      });
  });

  it('updates the current user only to a controlled preset identifier', async () => {
    await request(app.getHttpServer())
      .put('/api/me/avatar/preset')
      .set('Cookie', userAuth.cookie)
      .set('X-CSRF-Token', userAuth.csrfToken)
      .send({ presetId: 'preset-07' })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        avatarKind: 'PRESET',
        avatarValue: 'preset-07'
      }));

    await request(app.getHttpServer())
      .put('/api/me/avatar/preset')
      .set('Cookie', userAuth.cookie)
      .set('X-CSRF-Token', userAuth.csrfToken)
      .send({ presetId: '../outside.webp' })
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('VALIDATION_ERROR'));
  });

  it('re-encodes an uploaded image to a centered 256px webp', async () => {
    const response = await uploadAvatar(validPng).expect(201);
    expect(basename(response.body.path)).toBe(response.body.path);
    const metadata = await sharp(join(avatarRoot, response.body.path)).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: 256, height: 256 });
    sharp.cache(false);
    await expect(prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
      .resolves.toMatchObject({
        avatarKind: AvatarKind.UPLOAD,
        avatarValue: response.body.path
      });
  });

  it('rejects a script renamed to png without leaving a temporary file', async () => {
    const before = await readdir(avatarRoot);
    await uploadAvatar(Buffer.from('<script>alert(1)</script>'), 'face.png')
      .expect(415);
    expect(await readdir(avatarRoot)).toEqual(before);
  });

  it('rejects a forged MIME type even when the content is a decodable image', async () => {
    const before = await readdir(avatarRoot);
    await uploadAvatar(validPng, 'face.jpg', 'image/jpeg').expect(415);
    expect(await readdir(avatarRoot)).toEqual(before);
  });

  it('rejects payloads over five MiB without creating an avatar', async () => {
    const before = await readdir(avatarRoot);
    await uploadAvatar(Buffer.alloc(5 * 1024 * 1024 + 1, 1), 'large.png')
      .expect(413)
      .expect(({ body }) => expect(body.code).toBe('AVATAR_TOO_LARGE'));
    expect(await readdir(avatarRoot)).toEqual(before);
  });

  it('rejects decoded images with dimensions over the server limit', async () => {
    const tooWide = await sharp({
      create: { width: 4097, height: 1, channels: 3, background: '#ef4444' }
    }).png().toBuffer();
    const before = await readdir(avatarRoot);
    await uploadAvatar(tooWide).expect(415);
    expect(await readdir(avatarRoot)).toEqual(before);
  });

  it('removes the previous uploaded file only after a replacement is committed', async () => {
    const first = await uploadAvatar(validPng).expect(201);
    const secondPng = await sharp({
      create: { width: 300, height: 420, channels: 4, background: '#22c55e' }
    }).png().toBuffer();
    const second = await uploadAvatar(secondPng).expect(201);

    await expect(readFile(join(avatarRoot, first.body.path))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(avatarRoot, second.body.path))).resolves.toBeInstanceOf(Buffer);
  });

  it('releases Sharp readers and removes a replaced uploaded file', async () => {
    const first = await uploadAvatar(validPng).expect(201);
    await sharp(join(avatarRoot, first.body.path)).metadata();
    const second = await uploadAvatar(validPng).expect(201);

    expect(second.body.path).not.toBe(first.body.path);
    await expect(readFile(join(avatarRoot, first.body.path))).rejects.toMatchObject({ code: 'ENOENT' });
    sharp.cache(false);
  });

  it('keeps an uploaded file referenced by a historical game snapshot after replacement', async () => {
    const first = await uploadAvatar(validPng).expect(201);
    const game = await prisma.game.create({
      data: {
        name: `${prefix}-historical-replacement`,
        handPrice: 300n,
        rakeEnabled: true,
        status: GameStatus.COMPLETED,
        version: 3,
        createdById: admin.id,
        startedAt: new Date('2026-08-17T10:00:00.000Z'),
        stoppedAt: new Date('2026-08-17T12:00:00.000Z'),
        completedAt: new Date('2026-08-17T12:10:00.000Z')
      }
    });
    await prisma.gamePlayer.create({
      data: {
        gameId: game.id,
        userId: user.id,
        nicknameSnapshot: user.nickname,
        avatarKindSnapshot: AvatarKind.UPLOAD,
        avatarValueSnapshot: first.body.path,
        seatNo: 1,
        firstBuyinAt: new Date('2026-08-17T10:05:00.000Z')
      }
    });

    try {
      const second = await uploadAvatar(validPng).expect(201);
      expect(second.body.path).not.toBe(first.body.path);
      await expect(readFile(join(avatarRoot, first.body.path))).resolves.toBeInstanceOf(Buffer);
      await request(app.getHttpServer())
        .get(`/api/games/${game.id}/snapshot`)
        .set('Cookie', userAuth.cookie)
        .expect(200)
        .expect(({ body }) => expect(body.players).toEqual([
          expect.objectContaining({
            userId: user.id,
            avatarUrl: `/avatars/uploads/${first.body.path}`
          })
        ]));
      await expect(readFile(join(avatarRoot, basename(first.body.path))))
        .resolves.toBeInstanceOf(Buffer);
    } finally {
      await prisma.gamePlayer.deleteMany({ where: { gameId: game.id } });
      await prisma.game.delete({ where: { id: game.id } });
    }
  });

  it('keeps an uploaded file referenced by history after an administrator reset', async () => {
    const target = await seedUser('historical-reset-target', Role.USER);
    const oldFilename = `${target.id}-${randomUUID()}.webp`;
    await writeFile(join(avatarRoot, oldFilename), validPng);
    await prisma.user.update({
      where: { id: target.id },
      data: { avatarKind: AvatarKind.UPLOAD, avatarValue: oldFilename }
    });
    const game = await prisma.game.create({
      data: {
        name: `${prefix}-historical-reset`,
        handPrice: 300n,
        rakeEnabled: true,
        status: GameStatus.COMPLETED,
        version: 3,
        createdById: admin.id,
        startedAt: new Date(),
        stoppedAt: new Date(),
        completedAt: new Date()
      }
    });
    await prisma.gamePlayer.create({
      data: {
        gameId: game.id,
        userId: target.id,
        nicknameSnapshot: target.nickname,
        avatarKindSnapshot: AvatarKind.UPLOAD,
        avatarValueSnapshot: oldFilename,
        seatNo: 1,
        firstBuyinAt: new Date()
      }
    });

    try {
      await request(app.getHttpServer())
        .post(`/api/users/${target.id}/avatar/reset`)
        .set('Cookie', adminAuth.cookie)
        .set('X-CSRF-Token', adminAuth.csrfToken)
        .expect(200);
      await expect(readFile(join(avatarRoot, oldFilename))).resolves.toEqual(validPng);
    } finally {
      await prisma.gamePlayer.deleteMany({ where: { gameId: game.id } });
      await prisma.game.delete({ where: { id: game.id } });
    }
  });

  it('deletes an unreferenced controlled upload after an administrator reset', async () => {
    const target = await seedUser('unreferenced-reset-target', Role.USER);
    const oldFilename = `${target.id}-${randomUUID()}.webp`;
    await writeFile(join(avatarRoot, oldFilename), validPng);
    await prisma.user.update({
      where: { id: target.id },
      data: { avatarKind: AvatarKind.UPLOAD, avatarValue: oldFilename }
    });

    await request(app.getHttpServer())
      .post(`/api/users/${target.id}/avatar/reset`)
      .set('Cookie', adminAuth.cookie)
      .set('X-CSRF-Token', adminAuth.csrfToken)
      .expect(200);
    await expect(readFile(join(avatarRoot, oldFilename)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the old file and successful response when the history reference query fails', async () => {
    const target = await seedUser('reference-query-failure-target', Role.USER);
    const oldFilename = `${target.id}-${randomUUID()}.webp`;
    const oldPath = join(avatarRoot, oldFilename);
    await writeFile(oldPath, validPng);
    await prisma.user.update({
      where: { id: target.id },
      data: { avatarKind: AvatarKind.UPLOAD, avatarValue: oldFilename }
    });
    const count = vi.spyOn(prisma.gamePlayer, 'count').mockRejectedValueOnce(
      Object.assign(new Error('injected reference query failure'), { code: 'INJECTED_QUERY_FAILURE' })
    );

    try {
      await request(app.getHttpServer())
        .post(`/api/users/${target.id}/avatar/reset`)
        .set('Cookie', adminAuth.cookie)
        .set('X-CSRF-Token', adminAuth.csrfToken)
        .expect(200)
        .expect(({ body }) => expect(body).toMatchObject({
          avatarKind: 'PRESET',
          avatarValue: 'preset-01'
        }));
      expect(count).toHaveBeenCalledOnce();
      await expect(readFile(oldPath)).resolves.toEqual(validPng);
    } finally {
      count.mockRestore();
      await rm(oldPath, { force: true });
    }
  });

  it('keeps the old avatar and removes new files when the database commit is rejected', async () => {
    const target = await seedUser('commit-failure-target', Role.USER);
    const oldFilename = `${target.id}-${randomUUID()}.webp`;
    await writeFile(join(avatarRoot, oldFilename), validPng);
    await prisma.user.update({
      where: { id: target.id },
      data: { avatarKind: AvatarKind.UPLOAD, avatarValue: oldFilename }
    });
    const before = (await readdir(avatarRoot)).sort();
    let rowLocked!: () => void;
    const locked = new Promise<void>((resolve) => { rowLocked = resolve; });
    const blocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM users WHERE id = ${target.id} FOR UPDATE
      `;
      rowLocked();
      await delay(1_500);
      await transaction.user.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
    }, { timeout: 10_000, maxWait: 5_000 });
    await locked;
    const result = avatars.upload(target.id, {
      buffer: validPng,
      mimetype: 'image/png',
      originalname: 'replacement.png',
      size: validPng.length
    }).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    );

    await blocker;
    await expect(result).resolves.toMatchObject({
      status: 'rejected',
      reason: { code: 'NOT_FOUND' }
    });
    expect((await readdir(avatarRoot)).sort()).toEqual(before);
    await expect(readFile(join(avatarRoot, oldFilename))).resolves.toEqual(validPng);
  }, 15_000);

  it('re-authorizes an administrator avatar reset after a concurrent promotion', async () => {
    const target = await seedUser('avatar-race', Role.USER);
    let rowLocked!: () => void;
    const locked = new Promise<void>((resolve) => { rowLocked = resolve; });
    const blocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM users WHERE id = ${target.id} FOR UPDATE
      `;
      rowLocked();
      await delay(1_500);
      await transaction.user.update({
        where: { id: target.id },
        data: { role: Role.ADMIN }
      });
    }, { timeout: 10_000, maxWait: 5_000 });
    await locked;
    const result = avatars.resetByAdministrator(admin, target.id).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    );

    await blocker;
    await expect(result).resolves.toMatchObject({
      status: 'rejected',
      reason: { code: 'FORBIDDEN' }
    });
  }, 15_000);

  it('re-authorizes avatar reset after the administrator is demoted mid-request', async () => {
    const actor = await seedUser('avatar-actor-race', Role.ADMIN);
    const target = await seedUser('avatar-actor-target', Role.USER);
    let rowLocked!: () => void;
    const locked = new Promise<void>((resolve) => { rowLocked = resolve; });
    const blocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM users WHERE id = ${actor.id} FOR UPDATE
      `;
      rowLocked();
      await delay(1_500);
      await transaction.user.update({ where: { id: actor.id }, data: { role: Role.USER } });
    }, { timeout: 10_000, maxWait: 5_000 });
    await locked;
    const result = avatars.resetByAdministrator(actor, target.id).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    );

    await blocker;
    await expect(result).resolves.toMatchObject({
      status: 'rejected',
      reason: { code: 'FORBIDDEN' }
    });
  }, 15_000);

  it('lets an administrator reset an avatar without following a stored traversal path', async () => {
    const sentinelRoot = await mkdtemp(join(tmpdir(), 'poker-avatar-sentinel-'));
    const sentinel = join(sentinelRoot, 'sentinel.webp');
    await writeFile(sentinel, 'do-not-delete');
    const traversalTarget = await seedUser('traversal-target', Role.USER);
    await prisma.user.update({
      where: { id: traversalTarget.id },
      data: {
        avatarKind: AvatarKind.UPLOAD,
        avatarValue: join('..', basename(sentinelRoot), basename(sentinel))
      }
    });

    try {
      await request(app.getHttpServer())
        .post(`/api/users/${traversalTarget.id}/avatar/reset`)
        .set('Cookie', adminAuth.cookie)
        .set('X-CSRF-Token', adminAuth.csrfToken)
        .expect(200)
        .expect(({ body }) => expect(body).toMatchObject({
          avatarKind: 'PRESET',
          avatarValue: 'preset-01'
        }));
      await expect(readFile(sentinel, 'utf8')).resolves.toBe('do-not-delete');
    } finally {
      await rm(sentinelRoot, { recursive: true, force: true });
    }
  });
});
