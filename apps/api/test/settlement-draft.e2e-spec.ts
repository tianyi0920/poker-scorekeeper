import type { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import request, { type Response } from 'supertest';
import {
  settlementDraftResponseSchema,
  settlementPreviewResponseSchema
} from '@poker/contracts';
import {
  BuyinEventType,
  GameStatus,
  Role,
  type Game,
  type GamePlayer,
  type User
} from '../src/generated/prisma/client.js';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const databaseName = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
if (databaseName !== 'poker_scorekeeper_test') {
  throw new Error('Settlement draft E2E requires the exact poker_scorekeeper_test database');
}

const runId = randomUUID().replaceAll('-', '').slice(0, 10);
const prefix = `settlement-draft-${runId}`;
const password = `${randomBytes(18).toString('base64url')}Aa1!`;
const MAX_SIGNED_BIGINT = '9223372036854775807';

interface AuthContext {
  cookie: string;
  csrfToken: string;
}

interface GameFixture {
  game: Game;
  players: [GamePlayer, GamePlayer, GamePlayer];
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

describe.sequential('recoverable settlement drafts', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let passwordHash: string;
  let adminA: User;
  let adminB: User;
  let playerA: User;
  let playerB: User;
  let playerC: User;
  let adminAAuth: AuthContext;
  let adminBAuth: AuthContext;
  let playerAAuth: AuthContext;

  async function seedUser(suffix: string, role: Role): Promise<User> {
    const username = `${prefix}-${suffix}`;
    const nickname = `结算-${runId}-${suffix}`;
    return prisma.user.create({
      data: {
        username,
        normalizedUsername: normalize(username),
        nickname,
        activeNormalizedNickname: normalize(nickname),
        passwordHash,
        role,
        avatarValue: 'preset-04'
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

  function read(auth: AuthContext, path: string) {
    return request(app.getHttpServer()).get(path).set('Cookie', auth.cookie);
  }

  function write(
    auth: AuthContext,
    method: 'post' | 'put',
    path: string,
    body: object = {}
  ) {
    return request(app.getHttpServer())[method](path)
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrfToken)
      .send(body);
  }

  async function cleanOwnedGames(): Promise<void> {
    const games = await prisma.game.findMany({
      where: { name: { startsWith: prefix } },
      select: { id: true }
    });
    const gameIds = games.map(({ id }) => id);
    if (gameIds.length === 0) return;
    const players = await prisma.gamePlayer.findMany({
      where: { gameId: { in: gameIds } },
      select: { id: true }
    });
    const playerIds = players.map(({ id }) => id);
    const drafts = await prisma.settlementDraft.findMany({
      where: { gameId: { in: gameIds } },
      select: { id: true }
    });
    const draftIds = drafts.map(({ id }) => id);
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { entityType: 'GAME', entityId: { in: gameIds } },
          ...(draftIds.length === 0
            ? []
            : [{ entityType: 'SETTLEMENT_DRAFT', entityId: { in: draftIds } }])
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

  async function seedActiveGame(suffix: string): Promise<GameFixture> {
    const game = await prisma.game.create({
      data: {
        name: `${prefix}-${suffix}`,
        handPrice: 300n,
        rakeEnabled: true,
        status: GameStatus.ACTIVE,
        version: 1,
        createdById: adminA.id,
        startedAt: new Date(Date.now() - 30_000)
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
          nicknameSnapshot: user.nickname,
          avatarKindSnapshot: user.avatarKind,
          avatarValueSnapshot: user.avatarValue,
          seatNo: index + 1,
          firstBuyinAt: new Date()
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
    return { game, players: players as GameFixture['players'] };
  }

  async function beginSettlement(fixture: GameFixture, auth = adminAAuth): Promise<Response> {
    return write(
      auth,
      'post',
      `/api/games/${fixture.game.id}/begin-settlement`
    ).expect(200);
  }

  function balancedPayload(fixture: GameFixture, overrides: Record<string, unknown> = {}) {
    const [a, b, c] = fixture.players;
    return {
      cashOutByPlayerId: { [a.id]: '3000', [b.id]: '400', [c.id]: '200' },
      roomFee: '380',
      roomPayerIds: [],
      otherFee: '0',
      otherFeeNote: '',
      otherPayerIds: [],
      ...overrides
    };
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.CSRF_SECRET = randomBytes(32).toString('hex');
    process.env.BOOTSTRAP_ADMIN_USERNAME = `${prefix}-bootstrap`;
    process.env.BOOTSTRAP_ADMIN_NICKNAME = `结算根-${runId}`;
    process.env.BOOTSTRAP_ADMIN_PASSWORD = password;
    app = await createApp();
    prisma = app.get(PrismaService);
    await app.init();
    passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    adminA = await seedUser('admin-a', Role.ADMIN);
    adminB = await seedUser('admin-b', Role.ADMIN);
    playerA = await seedUser('player-a', Role.USER);
    playerB = await seedUser('player-b', Role.USER);
    playerC = await seedUser('player-c', Role.USER);
    adminAAuth = await login(adminA);
    adminBAuth = await login(adminB);
    playerAAuth = await login(playerA);
  }, 30_000);

  beforeEach(async () => {
    await cleanOwnedGames();
    await prisma.user.updateMany({
      where: { id: { in: [playerA.id, playerB.id, playerC.id] } },
      data: { rakeEnabled: true }
    });
  });

  afterAll(async () => {
    if (prisma !== undefined) {
      await cleanOwnedGames();
      const owned = await prisma.user.findMany({
        where: { normalizedUsername: { startsWith: normalize(prefix) } },
        select: { id: true }
      });
      const ids = owned.map(({ id }) => id);
      if (ids.length > 0) {
        await prisma.auditLog.deleteMany({ where: { actorUserId: { in: ids } } });
        await prisma.authSession.deleteMany({ where: { userId: { in: ids } } });
        await prisma.activePlayerLock.deleteMany({ where: { userId: { in: ids } } });
        await prisma.user.deleteMany({ where: { id: { in: ids } } });
      }
    }
    if (app !== undefined) await app.close();
  }, 30_000);

  it('creates the approved recoverable draft atomically when settlement begins', async () => {
    const fixture = await seedActiveGame('default');
    await beginSettlement(fixture);

    const response = await read(
      playerAAuth,
      `/api/games/${fixture.game.id}/settlement-draft`
    ).expect(200);
    expect(settlementDraftResponseSchema.parse(response.body)).toEqual(response.body);
    expect(response.body).toMatchObject({
      gameId: fixture.game.id,
      version: 1,
      draftVersion: 1,
      editorUserId: adminA.id,
      editorNickname: adminA.nickname,
      canEdit: false,
      canTakeOver: false,
      payload: {
        cashOutByPlayerId: Object.fromEntries(fixture.players.map(({ id }) => [id, ''])),
        roomFee: '380',
        roomPayerIds: [],
        otherFee: '0',
        otherFeeNote: '',
        otherPayerIds: []
      },
      previewReady: false,
      validationCode: 'CASH_OUTS_INCOMPLETE'
    });
    expect(new Date(response.body.leaseExpiresAt).getTime()).toBeGreaterThan(Date.now());
    await expect(prisma.settlementDraft.count({ where: { gameId: fixture.game.id } }))
      .resolves.toBe(1);
  });

  it('lets only the current administrator edit and extends the five-minute lease', async () => {
    const fixture = await seedActiveGame('editor');
    await beginSettlement(fixture);
    const before = await prisma.settlementDraft.update({
      where: { gameId: fixture.game.id },
      data: { leaseExpiresAt: new Date(Date.now() + 60_000) }
    });

    await write(playerAAuth, 'put', `/api/games/${fixture.game.id}/settlement-draft`, {
      version: 1,
      payload: balancedPayload(fixture)
    }).expect(403).expect(({ body }) => expect(body.code).toBe('FORBIDDEN'));
    await write(adminBAuth, 'put', `/api/games/${fixture.game.id}/settlement-draft`, {
      version: 1,
      payload: balancedPayload(fixture)
    }).expect(409).expect(({ body }) => {
      expect(body.code).toBe('DRAFT_EDITOR_CONFLICT');
      expect(body.details.latest.editorUserId).toBe(adminA.id);
    });

    const [a] = fixture.players;
    const response = await write(
      adminAAuth,
      'put',
      `/api/games/${fixture.game.id}/settlement-draft`,
      {
        version: 1,
        payload: {
          ...balancedPayload(fixture),
          cashOutByPlayerId: { [a.id]: '3000', [fixture.players[1].id]: '', [fixture.players[2].id]: '' }
        }
      }
    ).expect(200);
    expect(settlementDraftResponseSchema.parse(response.body)).toEqual(response.body);
    expect(response.body).toMatchObject({
      version: 2,
      draftVersion: 2,
      previewReady: false,
      validationCode: 'CASH_OUTS_INCOMPLETE'
    });
    expect(response.body.players.find(({ playerId }: { playerId: string }) => playerId === a.id))
      .toMatchObject({ buyIn: '1500', cashOut: '3000', rawProfit: '1500' });
    expect(new Date(response.body.leaseExpiresAt).getTime())
      .toBeGreaterThan(before.leaseExpiresAt.getTime());
  });

  it('does not advertise editability after the draft editor is demoted', async () => {
    const fixture = await seedActiveGame('demoted-editor');
    await beginSettlement(fixture);
    await prisma.user.update({ where: { id: adminA.id }, data: { role: Role.USER } });
    try {
      const response = await read(
        adminAAuth,
        `/api/games/${fixture.game.id}/settlement-draft`
      ).expect(200);
      expect(response.body).toMatchObject({
        editorUserId: adminA.id,
        canEdit: false,
        canTakeOver: false
      });
    } finally {
      adminA = await prisma.user.update({ where: { id: adminA.id }, data: { role: Role.ADMIN } });
    }
  });

  it('defaults each nonzero fee to the top winner on the first balanced save', async () => {
    const fixture = await seedActiveGame('winner');
    await beginSettlement(fixture);
    const [a] = fixture.players;

    const response = await write(
      adminAAuth,
      'put',
      `/api/games/${fixture.game.id}/settlement-draft`,
      { version: 1, payload: balancedPayload(fixture) }
    ).expect(200);
    expect(response.body).toMatchObject({
      version: 2,
      previewReady: true,
      validationCode: null,
      settingsVersion: expect.any(Number),
      payload: { roomPayerIds: [a.id], otherPayerIds: [] },
      totals: { buyIn: '3600', cashOut: '3600', roomFee: '380' }
    });
    expect(response.body.players.find(({ playerId }: { playerId: string }) => playerId === a.id))
      .toMatchObject({
        rawProfit: '1500',
        roomFeeShare: '380',
        afterFeeProfit: '1120'
      });
  });

  it('breaks a top-profit tie by the smaller seat number', async () => {
    const fixture = await seedActiveGame('tie');
    await beginSettlement(fixture);
    const [a, b, c] = fixture.players;
    const response = await write(adminAAuth, 'put', `/api/games/${fixture.game.id}/settlement-draft`, {
      version: 1,
      payload: balancedPayload(fixture, {
        cashOutByPlayerId: { [a.id]: '1600', [b.id]: '1900', [c.id]: '100' }
      })
    }).expect(200);
    expect(response.body.payload.roomPayerIds).toEqual([a.id]);
  });

  it('splits integer fees exactly by profit order and seat tie-breaks', async () => {
    const fixture = await seedActiveGame('split');
    await beginSettlement(fixture);
    const [a, b, c] = fixture.players;
    const response = await write(adminAAuth, 'put', `/api/games/${fixture.game.id}/settlement-draft`, {
      version: 1,
      payload: balancedPayload(fixture, { roomPayerIds: [a.id, b.id, c.id] })
    }).expect(200);
    const shares = Object.fromEntries(response.body.players.map(
      ({ playerId, roomFeeShare }: { playerId: string; roomFeeShare: string }) =>
        [playerId, roomFeeShare]
    ));
    expect(shares).toEqual({ [a.id]: '127', [b.id]: '126', [c.id]: '127' });
  });

  it('preserves an explicit empty payer edit after the default was chosen', async () => {
    const fixture = await seedActiveGame('payer-edit');
    await beginSettlement(fixture);
    const first = await write(adminAAuth, 'put', `/api/games/${fixture.game.id}/settlement-draft`, {
      version: 1,
      payload: balancedPayload(fixture)
    }).expect(200);
    const second = await write(adminAAuth, 'put', `/api/games/${fixture.game.id}/settlement-draft`, {
      version: first.body.version,
      payload: { ...first.body.payload, roomPayerIds: [] }
    }).expect(200);
    expect(second.body).toMatchObject({
      payload: { roomPayerIds: [] },
      previewReady: false,
      validationCode: 'ROOM_FEE_PAYERS_REQUIRED'
    });
  });

  it('rejects malformed payloads without changing the stored draft', async () => {
    const fixture = await seedActiveGame('validation');
    await beginSettlement(fixture);
    const before = await prisma.settlementDraft.findUniqueOrThrow({ where: { gameId: fixture.game.id } });
    await write(adminAAuth, 'put', `/api/games/${fixture.game.id}/settlement-draft`, {
      version: 1,
      payload: balancedPayload(fixture, { otherFee: '1', otherFeeNote: '' })
    }).expect(400).expect(({ body }) => expect(body.code).toBe('VALIDATION_ERROR'));
    await write(adminAAuth, 'put', `/api/games/${fixture.game.id}/settlement-draft`, {
      version: 1,
      payload: balancedPayload(fixture, {
        cashOutByPlayerId: { ...balancedPayload(fixture).cashOutByPlayerId, cmissing123: '0' }
      })
    }).expect(400).expect(({ body }) => expect(body.code).toBe('VALIDATION_ERROR'));
    await expect(prisma.settlementDraft.findUniqueOrThrow({ where: { gameId: fixture.game.id } }))
      .resolves.toMatchObject({ version: before.version, payload: before.payload });
  });

  it('returns the latest draft with stale-version conflicts', async () => {
    const fixture = await seedActiveGame('stale');
    await beginSettlement(fixture);
    await write(adminAAuth, 'put', `/api/games/${fixture.game.id}/settlement-draft`, {
      version: 1,
      payload: balancedPayload(fixture)
    }).expect(200);
    await write(adminAAuth, 'put', `/api/games/${fixture.game.id}/settlement-draft`, {
      version: 1,
      payload: balancedPayload(fixture, { roomFee: '500' })
    }).expect(409).expect(({ body }) => {
      expect(body.code).toBe('DRAFT_VERSION_CONFLICT');
      expect(body.details.latest).toMatchObject({ version: 2, payload: { roomFee: '380' } });
    });
  });

  it('allows takeover only after expiry and audits the old and new editors', async () => {
    const fixture = await seedActiveGame('takeover');
    await beginSettlement(fixture);
    await write(
      adminBAuth,
      'post',
      `/api/games/${fixture.game.id}/settlement-draft/takeover`
    ).expect(409).expect(({ body }) => expect(body.code).toBe('DRAFT_LEASE_ACTIVE'));
    await prisma.settlementDraft.update({
      where: { gameId: fixture.game.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) }
    });

    const response = await write(
      adminBAuth,
      'post',
      `/api/games/${fixture.game.id}/settlement-draft/takeover`
    ).expect(200);
    expect(response.body).toMatchObject({
      editorUserId: adminB.id,
      editorNickname: adminB.nickname,
      canEdit: true,
      canTakeOver: false,
      version: 2
    });
    const storedDraft = await prisma.settlementDraft.findUniqueOrThrow({
      where: { gameId: fixture.game.id }
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: {
        action: 'SETTLEMENT_TAKEN_OVER',
        entityType: 'SETTLEMENT_DRAFT',
        entityId: storedDraft.id
      }
    });
    expect(audit).toMatchObject({ actorUserId: adminB.id });
    expect(audit.beforeJson).toMatchObject({ editorUserId: adminA.id });
    expect(audit.afterJson).toMatchObject({ editorUserId: adminB.id });
  });

  it('uses current rake settings and each current user flag for every preview', async () => {
    const fixture = await seedActiveGame('live-rake');
    await beginSettlement(fixture);
    const originalSettings = await prisma.systemSetting.findUniqueOrThrow({ where: { id: 'singleton' } });
    try {
      await prisma.systemSetting.update({
        where: { id: 'singleton' },
        data: { rakeThreshold: 1000n, rakeBps: 1000, version: { increment: 1 } }
      });
      const first = await write(
        playerAAuth,
        'post',
        `/api/games/${fixture.game.id}/settlement-preview`,
        balancedPayload(fixture, { roomFee: '0' })
      ).expect(200);
      expect(first.body.players.find(({ playerId }: { playerId: string }) => playerId === fixture.players[0].id))
        .toMatchObject({ afterFeeProfit: '1500', rakeAmount: '150', finalAmount: '1350' });

      await prisma.user.update({ where: { id: playerA.id }, data: { rakeEnabled: false } });
      const second = await write(
        playerAAuth,
        'post',
        `/api/games/${fixture.game.id}/settlement-preview`,
        balancedPayload(fixture, { roomFee: '0' })
      ).expect(200);
      expect(second.body.settingsVersion).toBe(first.body.settingsVersion);
      expect(second.body.players.find(({ playerId }: { playerId: string }) => playerId === fixture.players[0].id))
        .toMatchObject({ rakeAmount: '0', finalAmount: '1500' });
    } finally {
      await prisma.systemSetting.update({
        where: { id: 'singleton' },
        data: {
          rakeThreshold: originalSettings.rakeThreshold,
          rakeBps: originalSettings.rakeBps,
          version: originalSettings.version,
          updatedById: originalSettings.updatedById
        }
      });
      await prisma.user.update({ where: { id: playerA.id }, data: { rakeEnabled: true } });
    }
  });

  it('returns stable unready previews for imbalance, missing payers, and derived BIGINT overflow', async () => {
    const fixture = await seedActiveGame('preview-errors');
    await beginSettlement(fixture);
    const [a, b, c] = fixture.players;
    const imbalance = await write(
      adminAAuth,
      'post',
      `/api/games/${fixture.game.id}/settlement-preview`,
      balancedPayload(fixture, { cashOutByPlayerId: { [a.id]: '3000', [b.id]: '400', [c.id]: '199' } })
    ).expect(200);
    expect(settlementPreviewResponseSchema.parse(imbalance.body)).toEqual(imbalance.body);
    expect(imbalance.body).toMatchObject({ previewReady: false, validationCode: 'TABLE_NOT_BALANCED' });

    const missingPayer = await write(
      adminAAuth,
      'post',
      `/api/games/${fixture.game.id}/settlement-preview`,
      balancedPayload(fixture)
    ).expect(200);
    expect(missingPayer.body).toMatchObject({
      previewReady: false,
      validationCode: 'ROOM_FEE_PAYERS_REQUIRED'
    });

    const overflow = await write(
      adminAAuth,
      'post',
      `/api/games/${fixture.game.id}/settlement-preview`,
      balancedPayload(fixture, {
        roomFee: MAX_SIGNED_BIGINT,
        roomPayerIds: [a.id],
        otherFee: MAX_SIGNED_BIGINT,
        otherFeeNote: '两项极限费用',
        otherPayerIds: [a.id]
      })
    ).expect(200);
    expect(overflow.body).toMatchObject({ previewReady: false, validationCode: 'MONEY_OVERFLOW' });
  });
});
