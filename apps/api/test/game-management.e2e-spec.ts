import type { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { managedGamesResponseSchema } from '@poker/contracts';
import request, { type Response } from 'supertest';
import { GameStatus, Role, type Game, type User } from '../src/generated/prisma/client.js';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { requireAuthorizedTestDatabase } from './support/authorized-test-database.js';

requireAuthorizedTestDatabase();
const runId = randomUUID().replaceAll('-', '').slice(0, 8);
const prefix = `manage-${runId}`;
const password = `${randomBytes(18).toString('base64url')}Aa1!`;

interface AuthContext {
  cookie: string;
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

function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe.sequential('super-administrator game management list', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let passwordHash: string;
  let superUser: User;
  let adminUser: User;
  let regularUser: User;
  let superAuth: AuthContext;
  let adminAuth: AuthContext;
  let userAuth: AuthContext;

  function gameId(suffix: string): string {
    return `gm-${runId}-${suffix}`;
  }

  async function seedUser(suffix: string, role: Role): Promise<User> {
    const username = `${prefix}-${suffix}`;
    const nickname = `管理-${runId}-${suffix}`;
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
    return { cookie: cookieFrom(response) };
  }

  function read(auth: AuthContext | undefined, path: string) {
    const call = request(app.getHttpServer()).get(path);
    return auth === undefined ? call : call.set('Cookie', auth.cookie);
  }

  async function seedGame(
    suffix: string,
    status: GameStatus,
    createdAt: Date,
    overrides: { id?: string; completedAt?: Date | null } = {}
  ) {
    return prisma.game.create({
      data: {
        id: overrides.id ?? gameId(suffix),
        name: `${prefix}-${suffix}`,
        status,
        handPrice: 300n,
        rakeEnabled: true,
        version: 1,
        createdById: superUser.id,
        createdAt,
        startedAt: status === GameStatus.DRAFT ? null : createdAt,
        stoppedAt: status === GameStatus.SETTLING ||
          status === GameStatus.COMPLETED ||
          status === GameStatus.VOIDED
          ? createdAt
          : null,
        completedAt: overrides.completedAt ?? (
          status === GameStatus.COMPLETED ? createdAt : null
        )
      }
    });
  }

  async function cleanOwnedGames(): Promise<void> {
    const owned = await prisma.game.findMany({
      where: { createdById: superUser.id },
      select: { id: true }
    });
    const gameIds = owned.map(({ id }) => id);
    if (gameIds.length === 0) return;
    await prisma.gamePlayer.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.game.deleteMany({ where: { id: { in: gameIds } } });
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
    superUser = await seedUser('super', Role.SUPER_ADMIN);
    adminUser = await seedUser('admin', Role.ADMIN);
    regularUser = await seedUser('user', Role.USER);
    superAuth = await login(superUser);
    adminAuth = await login(adminUser);
    userAuth = await login(regularUser);
  }, 30_000);

  beforeEach(async () => {
    await cleanOwnedGames();
  });

  afterAll(async () => {
    if (prisma !== undefined) {
      await cleanOwnedGames();
      const ownedUsers = await prisma.user.findMany({
        where: { normalizedUsername: { startsWith: normalize(prefix) } },
        select: { id: true }
      });
      const userIds = ownedUsers.map(({ id }) => id);
      if (userIds.length > 0) {
        await prisma.authSession.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
    }
    if (app !== undefined) await app.close();
  }, 30_000);

  it.each([
    ['anonymous', undefined, 401, 'UNAUTHENTICATED'],
    ['user', () => userAuth, 403, 'FORBIDDEN'],
    ['admin', () => adminAuth, 403, 'FORBIDDEN']
  ] as const)('rejects %s from the management list', async (_label, auth, status, code) => {
    await read(typeof auth === 'function' ? auth() : auth, '/api/games/manage?limit=2')
      .expect(status)
      .expect(({ body }) => expect(body.code).toBe(code));
  });

  it('allows a super administrator and returns all five statuses with exact player counts', async () => {
    const statuses = [
      GameStatus.DRAFT,
      GameStatus.ACTIVE,
      GameStatus.SETTLING,
      GameStatus.COMPLETED,
      GameStatus.VOIDED
    ];
    const games: Game[] = [];
    for (const [index, status] of statuses.entries()) {
      games.push(await seedGame(
        `status-${index}`,
        status,
        new Date(`2099-01-01T00:00:0${index}.000Z`)
      ));
    }
    await prisma.gamePlayer.createMany({
      data: [superUser, adminUser, regularUser].map((user, index) => ({
        id: gameId(`player-${index}`),
        gameId: games[1]!.id,
        userId: user.id,
        nicknameSnapshot: user.nickname,
        avatarKindSnapshot: user.avatarKind,
        avatarValueSnapshot: user.avatarValue,
        seatNo: index + 1,
        firstBuyinAt: new Date('2099-01-01T00:01:00.000Z')
      }))
    });

    const response = await read(superAuth, '/api/games/manage').expect(200);
    expect(managedGamesResponseSchema.safeParse(response.body).success).toBe(true);
    const seededItems = response.body.items.filter(({ id }: { id: string }) =>
      games.some((game) => game.id === id)
    );
    expect(seededItems.map(({ status }: { status: GameStatus }) => status))
      .toEqual([...statuses].reverse());
    expect(seededItems.find(({ id }: { id: string }) => id === games[1]!.id).playerCount)
      .toBe(3);
    expect(seededItems.filter(({ id }: { id: string }) => id !== games[1]!.id))
      .toEqual(expect.arrayContaining(
        games.filter(({ id }) => id !== games[1]!.id).map(({ id }) =>
          expect.objectContaining({ id, playerCount: 0 })
        )
      ));
  });

  it('defaults to 50 items and rejects limits outside 1 through 50', async () => {
    await prisma.game.createMany({
      data: Array.from({ length: 51 }, (_, index) => ({
        id: gameId(`default-${String(index).padStart(2, '0')}`),
        name: `${prefix}-default-${index}`,
        status: GameStatus.DRAFT,
        handPrice: 300n,
        rakeEnabled: true,
        version: 1,
        createdById: superUser.id,
        createdAt: new Date('2099-02-01T00:00:00.000Z')
      }))
    });

    await read(superAuth, '/api/games/manage')
      .expect(200)
      .expect(({ body }) => {
        expect(body.items).toHaveLength(50);
        expect(body.nextCursor).toEqual(expect.any(String));
      });
    for (const limit of [0, 51]) {
      await read(superAuth, `/api/games/manage?limit=${limit}`)
        .expect(400)
        .expect(({ body }) => expect(body.code).toBe('VALIDATION_ERROR'));
    }
  });

  it.each([
    ['invalid base64url', 'not+a+base64url'],
    ['non-JSON payload', Buffer.from('not-json').toString('base64url')],
    ['invalid timestamp', encodeCursor({ createdAt: 'yesterday', id: 'game-1' })],
    ['non-canonical public id', encodeCursor({ createdAt: '2099-01-01T00:00:00.000Z', id: 'GAME-1' })],
    ['unknown cursor field', encodeCursor({
      createdAt: '2099-01-01T00:00:00.000Z', id: 'game-1', offset: 2
    })]
  ])('rejects a malformed cursor with VALIDATION_ERROR: %s', async (_label, cursor) => {
    await read(superAuth, `/api/games/manage?cursor=${encodeURIComponent(cursor)}`)
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('VALIDATION_ERROR'));
  });

  it('uses descending public IDs to break equal-createdAt ties without duplicates or omissions', async () => {
    const createdAt = new Date('2099-03-01T00:00:00.000Z');
    const expectedIds = ['g', 'f', 'e', 'd', 'c', 'b', 'a'].map((suffix) =>
      gameId(`tie-${suffix}`)
    );
    for (const id of [...expectedIds].reverse()) {
      await seedGame(id.slice(`gm-${runId}-`.length), GameStatus.DRAFT, createdAt, { id });
    }
    const externalId = gameId('tie-dd');
    await prisma.game.create({
      data: {
        id: externalId,
        name: `${prefix}-external-tie`,
        status: GameStatus.DRAFT,
        handPrice: 300n,
        rakeEnabled: true,
        version: 1,
        createdById: adminUser.id,
        createdAt
      }
    });

    try {
      const expectedIdSet = new Set(expectedIds);
      const targetOrder: string[] = [];
      const targetCounts = new Map<string, number>();
      const visitedCursors = new Set<string>();
      const pageSize = 3;
      const maxPages = Math.ceil((await prisma.game.count()) / pageSize) + 2;
      let cursor: string | undefined;
      let reachedFinalPage = false;

      for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
        const path = cursor === undefined
          ? `/api/games/manage?limit=${pageSize}`
          : `/api/games/manage?limit=${pageSize}&cursor=${encodeURIComponent(cursor)}`;
        const response = await read(superAuth, path).expect(200);
        for (const item of response.body.items as Array<{ id: string }>) {
          if (!expectedIdSet.has(item.id)) continue;
          targetOrder.push(item.id);
          targetCounts.set(item.id, (targetCounts.get(item.id) ?? 0) + 1);
        }

        if (response.body.nextCursor === null) {
          reachedFinalPage = true;
          break;
        }
        if (typeof response.body.nextCursor !== 'string') {
          throw new Error('Management pagination returned neither a cursor nor null');
        }
        expect(visitedCursors.has(response.body.nextCursor)).toBe(false);
        visitedCursors.add(response.body.nextCursor);
        cursor = response.body.nextCursor;
      }

      expect(reachedFinalPage).toBe(true);
      expect(targetOrder).toEqual(expectedIds);
      expect(expectedIds.map((id) => targetCounts.get(id) ?? 0))
        .toEqual(expectedIds.map(() => 1));
    } finally {
      const cleaned = await prisma.game.deleteMany({ where: { id: externalId } });
      expect(cleaned.count).toBe(1);
    }
  });
});
