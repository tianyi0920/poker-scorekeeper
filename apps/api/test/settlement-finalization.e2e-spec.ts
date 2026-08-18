import type { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import request, { type Response } from 'supertest';
import {
  BuyinEventType,
  GameStatus,
  Role,
  type Game,
  type GamePlayer,
  type SystemSetting,
  type User
} from '../src/generated/prisma/client.js';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const databaseName = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
if (databaseName !== 'poker_scorekeeper_test') {
  throw new Error('Settlement finalization E2E requires the exact poker_scorekeeper_test database');
}

const runId = randomUUID().replaceAll('-', '').slice(0, 10);
const prefix = `settlement-final-${runId}`;
const password = `${randomBytes(18).toString('base64url')}Aa1!`;

interface AuthContext {
  cookie: string;
  csrfToken: string;
}

interface Fixture {
  game: Game;
  players: [GamePlayer, GamePlayer, GamePlayer];
  draftVersion: number;
}

function normalize(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function cookieFrom(response: Response): string {
  const header = response.headers['set-cookie'];
  const serialized = Array.isArray(header) ? header[0] : header;
  expect(serialized).toBeDefined();
  return serialized!.split(';', 1)[0]!;
}

describe.sequential('atomic final settlement', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let passwordHash: string;
  let admin: User;
  let playerA: User;
  let playerB: User;
  let playerC: User;
  let adminAuth: AuthContext;
  let playerAuth: AuthContext;
  let originalSettings: SystemSetting;

  async function seedUser(suffix: string, role: Role, rakeEnabled = true): Promise<User> {
    const username = `${prefix}-${suffix}`;
    const nickname = `锁定-${runId}-${suffix}`;
    return prisma.user.create({
      data: {
        username,
        normalizedUsername: normalize(username),
        nickname,
        activeNormalizedNickname: normalize(nickname),
        passwordHash,
        role,
        rakeEnabled,
        avatarValue: `preset-0${suffix.endsWith('a') ? '1' : suffix.endsWith('b') ? '2' : '3'}`
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

  function write(auth: AuthContext, path: string, body: object) {
    return request(app.getHttpServer())
      .post(path)
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrfToken)
      .send(body);
  }

  function read(auth: AuthContext, path: string) {
    return request(app.getHttpServer()).get(path).set('Cookie', auth.cookie);
  }

  async function confirmationToken(fixture: Fixture): Promise<string> {
    const response = await read(
      adminAuth,
      `/api/games/${fixture.game.id}/settlement-draft`
    ).expect(200);
    expect(response.body).toMatchObject({
      draftVersion: fixture.draftVersion,
      settingsVersion: 7,
      previewReady: true,
      confirmationToken: expect.any(String)
    });
    return response.body.confirmationToken;
  }

  async function seedFixture(suffix: string): Promise<Fixture> {
    const startedAt = new Date(Date.now() - 3_600_000);
    const stoppedAt = new Date(startedAt.getTime() + 3_000_000);
    const game = await prisma.game.create({
      data: {
        name: `${prefix}-${suffix}`,
        handPrice: 300n,
        rakeEnabled: true,
        status: GameStatus.SETTLING,
        version: 5,
        createdById: admin.id,
        startedAt,
        stoppedAt
      }
    });
    const users = [playerA, playerB, playerC] as const;
    const hands = [5, 6, 1] as const;
    const players: GamePlayer[] = [];
    for (let index = 0; index < users.length; index += 1) {
      const user = users[index]!;
      const player = await prisma.gamePlayer.create({
        data: {
          gameId: game.id,
          userId: user.id,
          nicknameSnapshot: `${user.nickname}-快照`,
          avatarKindSnapshot: user.avatarKind,
          avatarValueSnapshot: user.avatarValue,
          seatNo: index + 1,
          firstBuyinAt: startedAt
        }
      });
      const eventId = randomBytes(15).toString('hex');
      await prisma.buyinEvent.create({
        data: {
          id: eventId,
          gameId: game.id,
          gamePlayerId: player.id,
          actorUserId: user.id,
          type: BuyinEventType.BUY,
          logicalBuyId: eventId,
          previousHands: null,
          newHands: hands[index]!,
          handsDelta: hands[index]!,
          gameVersion: index + 2,
          idempotencyKey: `${prefix}-${suffix}-${index}`
        }
      });
      await prisma.activePlayerLock.create({ data: { gameId: game.id, userId: user.id } });
      players.push(player);
    }
    const typedPlayers = players as Fixture['players'];
    const draft = await prisma.settlementDraft.create({
      data: {
        gameId: game.id,
        editorUserId: admin.id,
        updatedById: admin.id,
        leaseExpiresAt: new Date(Date.now() + 300_000),
        version: 4,
        payload: {
          cashOutByPlayerId: {
            [typedPlayers[0].id]: '3000',
            [typedPlayers[1].id]: '400',
            [typedPlayers[2].id]: '200'
          },
          roomFee: '380',
          roomPayerIds: [typedPlayers[0].id, typedPlayers[1].id, typedPlayers[2].id],
          otherFee: '101',
          otherFeeNote: '饮料',
          otherPayerIds: [typedPlayers[0].id, typedPlayers[2].id]
        }
      }
    });
    return { game, players: typedPlayers, draftVersion: draft.version };
  }

  async function cleanOwnedGames(): Promise<void> {
    const games = await prisma.game.findMany({
      where: { name: { startsWith: prefix } },
      select: { id: true }
    });
    const gameIds = games.map(({ id }) => id);
    if (gameIds.length === 0) return;
    const players = await prisma.gamePlayer.findMany({
      where: { gameId: { in: gameIds } }, select: { id: true }
    });
    const playerIds = players.map(({ id }) => id);
    const settlementIds = (await prisma.settlement.findMany({
      where: { gameId: { in: gameIds } }, select: { id: true }
    })).map(({ id }) => id);
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { entityType: 'GAME', entityId: { in: gameIds } },
          ...(settlementIds.length === 0
            ? []
            : [{ entityType: 'SETTLEMENT', entityId: { in: settlementIds } }])
        ]
      }
    });
    if (playerIds.length > 0) {
      await prisma.settlementFeeAllocation.deleteMany({ where: { gamePlayerId: { in: playerIds } } });
      await prisma.settlementResult.deleteMany({ where: { gamePlayerId: { in: playerIds } } });
    }
    await prisma.settlement.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.settlementDraft.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.buyinEvent.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.activePlayerLock.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.gamePlayer.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.game.deleteMany({ where: { id: { in: gameIds } } });
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.CSRF_SECRET = randomBytes(32).toString('hex');
    process.env.BOOTSTRAP_ADMIN_USERNAME = `${prefix}-bootstrap`;
    process.env.BOOTSTRAP_ADMIN_NICKNAME = `锁定根-${runId}`;
    process.env.BOOTSTRAP_ADMIN_PASSWORD = password;
    app = await createApp();
    prisma = app.get(PrismaService);
    await app.init();
    passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    admin = await seedUser('admin', Role.ADMIN);
    playerA = await seedUser('player-a', Role.USER, true);
    playerB = await seedUser('player-b', Role.USER, true);
    playerC = await seedUser('player-c', Role.USER, false);
    adminAuth = await login(admin);
    playerAuth = await login(playerA);
    originalSettings = await prisma.systemSetting.findUniqueOrThrow({ where: { id: 'singleton' } });
  }, 30_000);

  beforeEach(async () => {
    await cleanOwnedGames();
    await prisma.systemSetting.update({
      where: { id: 'singleton' },
      data: { rakeThreshold: 1000n, rakeBps: 1000, version: 7, updatedById: null }
    });
    await prisma.user.updateMany({
      where: { id: { in: [playerA.id, playerB.id] } }, data: { rakeEnabled: true }
    });
    await prisma.user.update({ where: { id: playerC.id }, data: { rakeEnabled: false } });
  });

  afterAll(async () => {
    if (prisma !== undefined) {
      await cleanOwnedGames();
      await prisma.systemSetting.update({
        where: { id: 'singleton' },
        data: {
          rakeThreshold: originalSettings.rakeThreshold,
          rakeBps: originalSettings.rakeBps,
          version: originalSettings.version,
          updatedById: originalSettings.updatedById
        }
      });
      const users = await prisma.user.findMany({
        where: { normalizedUsername: { startsWith: normalize(prefix) } }, select: { id: true }
      });
      const ids = users.map(({ id }) => id);
      if (ids.length > 0) {
        await prisma.auditLog.deleteMany({ where: { actorUserId: { in: ids } } });
        await prisma.authSession.deleteMany({ where: { userId: { in: ids } } });
        await prisma.activePlayerLock.deleteMany({ where: { userId: { in: ids } } });
        await prisma.user.deleteMany({ where: { id: { in: ids } } });
      }
    }
    if (app !== undefined) await app.close();
  }, 30_000);

  it('persists the exact approved breakdown and releases locks in one permanent settlement', async () => {
    // Break caught: finalization partially persists, reuses profile data, or applies the wrong fee/rake formula.
    const fixture = await seedFixture('happy');
    const token = await confirmationToken(fixture);
    const response = await write(
      adminAuth,
      `/api/games/${fixture.game.id}/settlement-finalize`,
      { draftVersion: fixture.draftVersion, settingsVersion: 7, confirmationToken: token }
    ).expect(201);

    expect(response.body).toMatchObject({
      immutable: true,
      game: {
        id: fixture.game.id,
        name: fixture.game.name,
        durationSeconds: 3000
      },
      settledByNickname: admin.nickname,
      otherFeeNote: '饮料',
      totals: {
        buyIn: '3600', cashOut: '3600', roomFee: '380', otherFee: '101', rake: '132', final: '-613'
      }
    });
    const byPlayer = Object.fromEntries(response.body.players.map(
      (player: { playerId: string }) => [player.playerId, player]
    ));
    expect(byPlayer[fixture.players[0].id]).toMatchObject({
      nickname: `${playerA.nickname}-快照`,
      avatarKind: playerA.avatarKind,
      avatarValue: playerA.avatarValue,
      seatNo: 1,
      buyIn: '1500', cashOut: '3000', rawProfit: '1500',
      roomFeeShare: '127', otherFeeShare: '51', afterFeeProfit: '1322',
      rakeEligible: true, rakeAmount: '132', finalAmount: '1190'
    });
    expect(byPlayer[fixture.players[1].id]).toMatchObject({
      roomFeeShare: '126', otherFeeShare: '0', afterFeeProfit: '-1526',
      rakeEligible: false, rakeAmount: '0', finalAmount: '-1526'
    });
    expect(byPlayer[fixture.players[2].id]).toMatchObject({
      roomFeeShare: '127', otherFeeShare: '50', afterFeeProfit: '-277',
      rakeEligible: false, rakeAmount: '0', finalAmount: '-277'
    });
    expect(response.body.players.reduce(
      (sum: bigint, player: { finalAmount: string }) => sum + BigInt(player.finalAmount), 0n
    )).toBe(-613n);

    await expect(prisma.settlement.count({ where: { gameId: fixture.game.id } })).resolves.toBe(1);
    await expect(prisma.settlementResult.count({
      where: { settlement: { gameId: fixture.game.id } }
    })).resolves.toBe(3);
    await expect(prisma.settlementFeeAllocation.count({
      where: { settlement: { gameId: fixture.game.id } }
    })).resolves.toBe(5);
    await expect(prisma.activePlayerLock.count({ where: { gameId: fixture.game.id } })).resolves.toBe(0);
    await expect(prisma.game.findUniqueOrThrow({ where: { id: fixture.game.id } }))
      .resolves.toMatchObject({ status: GameStatus.COMPLETED, settledById: admin.id });
    await expect(prisma.auditLog.count({
      where: { action: 'SETTLEMENT_FINALIZED', entityType: 'SETTLEMENT' }
    })).resolves.toBe(1);
  });

  it('returns recoverable conflicts for stale draft and settings previews without persisting', async () => {
    // Break caught: a stale preview is silently committed under different money or rake inputs.
    const fixture = await seedFixture('stale');
    const token = await confirmationToken(fixture);
    await write(adminAuth, `/api/games/${fixture.game.id}/settlement-finalize`, {
      draftVersion: fixture.draftVersion - 1,
      settingsVersion: 7,
      confirmationToken: token
    }).expect(409).expect(({ body }) => {
      expect(body).toMatchObject({
        code: 'DRAFT_VERSION_CONFLICT',
        details: { currentDraftVersion: fixture.draftVersion }
      });
    });
    await write(adminAuth, `/api/games/${fixture.game.id}/settlement-finalize`, {
      draftVersion: fixture.draftVersion,
      settingsVersion: 6,
      confirmationToken: token
    }).expect(409).expect(({ body }) => {
      expect(body).toMatchObject({
        code: 'SETTINGS_VERSION_CONFLICT',
        details: { currentSettingsVersion: 7 }
      });
    });
    await expect(prisma.settlement.count({ where: { gameId: fixture.game.id } })).resolves.toBe(0);
    await expect(prisma.activePlayerLock.count({ where: { gameId: fixture.game.id } })).resolves.toBe(3);
  });

  it('creates exactly one permanent settlement for duplicate concurrent submits', async () => {
    // Break caught: two requests both pass an unlocked precondition and each persist a settlement.
    const fixture = await seedFixture('duplicate');
    const token = await confirmationToken(fixture);
    const command = { draftVersion: fixture.draftVersion, settingsVersion: 7, confirmationToken: token };
    const responses = await Promise.all([
      write(adminAuth, `/api/games/${fixture.game.id}/settlement-finalize`, command),
      write(adminAuth, `/api/games/${fixture.game.id}/settlement-finalize`, command)
    ]);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
    await expect(prisma.settlement.count({ where: { gameId: fixture.game.id } })).resolves.toBe(1);
    await expect(prisma.settlementResult.count({ where: { settlement: { gameId: fixture.game.id } } }))
      .resolves.toBe(3);
  });

  it('revalidates current role, editor ownership, canonical input, and balanced draft inside finalization', async () => {
    // Break caught: controller-only authorization or stale editor/data can bypass the transaction invariants.
    const fixture = await seedFixture('guards');
    const token = await confirmationToken(fixture);
    await write(playerAuth, `/api/games/${fixture.game.id}/settlement-finalize`, {
      draftVersion: fixture.draftVersion, settingsVersion: 7, confirmationToken: token
    }).expect(403);
    // Expiry enables takeover, but it does not evict the still-current editor.
    await prisma.settlementDraft.update({
      where: { gameId: fixture.game.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) }
    });
    await write(adminAuth, `/api/games/${fixture.game.id}/settlement-finalize`, {
      draftVersion: fixture.draftVersion, settingsVersion: 7, confirmationToken: token
    }).expect(201);
    await write(adminAuth, '/api/games/not canonical/settlement-finalize', {
      draftVersion: 4, settingsVersion: 7, confirmationToken: token
    }).expect(400).expect(({ body }) => expect(body.code).toBe('VALIDATION_ERROR'));
    await write(adminAuth, `/api/games/${fixture.game.id}/settlement-finalize`, {
      draftVersion: 4, settingsVersion: 7, confirmationToken: token, unexpected: true
    }).expect(400).expect(({ body }) => expect(body.code).toBe('VALIDATION_ERROR'));
  }, 30_000);

  it('binds confirmation to the saved payload and every current player rake flag', async () => {
    // Break caught: finalization locks draft A after the user confirmed unsaved preview B or stale rake eligibility.
    const fixture = await seedFixture('confirmation-binding');
    const [a, b, c] = fixture.players;
    const unsavedPreview = await write(
      adminAuth,
      `/api/games/${fixture.game.id}/settlement-preview`,
      {
        cashOutByPlayerId: { [a.id]: '2500', [b.id]: '900', [c.id]: '200' },
        roomFee: '0', roomPayerIds: [], otherFee: '0', otherFeeNote: '', otherPayerIds: []
      }
    ).expect(200);
    expect(unsavedPreview.body.confirmationToken).toEqual(expect.any(String));
    await write(adminAuth, `/api/games/${fixture.game.id}/settlement-finalize`, {
      draftVersion: fixture.draftVersion,
      settingsVersion: 7,
      confirmationToken: unsavedPreview.body.confirmationToken
    }).expect(409).expect(({ body }) => expect(body.code).toBe('SETTLEMENT_PREVIEW_CONFLICT'));

    const savedToken = await confirmationToken(fixture);
    await prisma.user.update({ where: { id: playerA.id }, data: { rakeEnabled: false } });
    await write(adminAuth, `/api/games/${fixture.game.id}/settlement-finalize`, {
      draftVersion: fixture.draftVersion,
      settingsVersion: 7,
      confirmationToken: savedToken
    }).expect(409).expect(({ body }) => {
      expect(body).toMatchObject({
        code: 'SETTLEMENT_PREVIEW_CONFLICT',
        details: { refreshRequired: true }
      });
    });
    await expect(prisma.settlement.count({ where: { gameId: fixture.game.id } })).resolves.toBe(0);
  });

  it('returns immutable full-table history only to participating users', async () => {
    // Break caught: a user can enumerate another table, or history rebuilds identities from mutable profiles.
    const fixture = await seedFixture('history');
    const token = await confirmationToken(fixture);
    await write(adminAuth, `/api/games/${fixture.game.id}/settlement-finalize`, {
      draftVersion: fixture.draftVersion, settingsVersion: 7, confirmationToken: token
    }).expect(201);
    const list = await read(playerAuth, '/api/history?limit=99').expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ gameId: fixture.game.id, final: '-613' });
    expect(list.body.nextCursor).toBeNull();
    const detail = await read(playerAuth, `/api/history/${fixture.game.id}`).expect(200);
    expect(detail.body).toMatchObject({ immutable: true, otherFeeNote: '饮料' });
    expect(detail.body.players).toHaveLength(3);
    await read(playerAuth, `/api/history/c${'a'.repeat(24)}`).expect(404)
      .expect(({ body }) => expect(body.code).toBe('HISTORY_SCOPE_DENIED'));
  });
});
