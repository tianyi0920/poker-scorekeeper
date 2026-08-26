import type { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import request, { type Response } from 'supertest';
import { allPlayerAggregationSchema } from '@poker/contracts';
import { GameStatus, Role, type User } from '../src/generated/prisma/client.js';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { requireAuthorizedTestDatabase } from './support/authorized-test-database.js';

requireAuthorizedTestDatabase();

const runId = randomUUID().replaceAll('-', '').slice(0, 8);
const prefix = `history-aggregate-${runId}`;
const password = `${randomBytes(18).toString('base64url')}Aa1!`;
const normalize = (value: string) => value.trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
let passwordHash: string;

interface Auth { cookie: string; csrfToken: string }
interface ResultInput {
  user: User;
  nickname: string;
  avatarUrl: string;
  rawProfit: bigint;
  roomFeeShare: bigint;
  otherFeeShare: bigint;
  afterFeeProfit: bigint;
  rakeAmount: bigint;
  finalAmount: bigint;
}

function loginFrom(response: Response): Auth {
  const setCookie = Array.isArray(response.headers['set-cookie'])
    ? response.headers['set-cookie'][0]
    : response.headers['set-cookie'];
  return { cookie: setCookie!.split(';', 1)[0]!, csrfToken: response.body.csrfToken as string };
}

describe.sequential('authorized all-player history aggregation', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: User;
  let superAdmin: User;
  let participant: User;
  let opponent: User;
  let thirdPlayer: User;
  let tieAlpha: User;
  let tieBeta: User;
  let outsider: User;
  let adminAuth: Auth;
  let superAdminAuth: Auth;
  let participantAuth: Auth;

  const aggregateAs = (auth: Auth, body: unknown) => request(app.getHttpServer())
    .post('/api/history/aggregate')
    .set('Cookie', auth.cookie)
    .set('X-CSRF-Token', auth.csrfToken)
    .send(body as object);

  async function seedUser(suffix: string, role: Role, nickname: string): Promise<User> {
    const username = `${prefix}-${suffix}`;
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

  async function seedCompleted(
    tag: string,
    completedAt: Date,
    results: ResultInput[]
  ): Promise<string> {
    const startedAt = new Date(completedAt.getTime() - 3_000);
    const game = await prisma.game.create({
      data: {
        name: `${prefix}-${tag}`,
        handPrice: 300n,
        status: GameStatus.COMPLETED,
        createdById: admin.id,
        startedAt,
        stoppedAt: new Date(completedAt.getTime() - 1_000),
        completedAt,
        settledById: admin.id
      }
    });
    const players = await Promise.all(results.map((result, index) => prisma.gamePlayer.create({
      data: {
        gameId: game.id,
        userId: result.user.id,
        nicknameSnapshot: result.nickname,
        avatarKindSnapshot: result.user.avatarKind,
        avatarValueSnapshot: result.avatarUrl,
        seatNo: index + 1,
        firstBuyinAt: startedAt
      }
    })));
    const settlement = await prisma.settlement.create({
      data: {
        gameId: game.id,
        buyInTotal: 0n,
        cashOutTotal: 0n,
        roomFee: results.reduce((total, result) => total + result.roomFeeShare, 0n),
        otherFee: results.reduce((total, result) => total + result.otherFeeShare, 0n),
        otherFeeNote: '',
        rakeThresholdUsed: 1000n,
        rakeBpsUsed: 1000,
        settingsVersionUsed: 1,
        rakeTotal: results.reduce((total, result) => total + result.rakeAmount, 0n),
        finalTotal: results.reduce((total, result) => total + result.finalAmount, 0n),
        settledById: admin.id,
        settledByNicknameSnapshot: '结算快照',
        lockedAt: completedAt
      }
    });
    await prisma.settlementResult.createMany({
      data: results.map((result, index) => ({
        settlementId: settlement.id,
        gamePlayerId: players[index]!.id,
        buyIn: 0n,
        cashOut: 0n,
        rawProfit: result.rawProfit,
        roomFeeShare: result.roomFeeShare,
        otherFeeShare: result.otherFeeShare,
        afterFeeProfit: result.afterFeeProfit,
        rakeEligible: result.rakeAmount > 0n,
        rakeAmount: result.rakeAmount,
        finalAmount: result.finalAmount
      }))
    });
    return game.id;
  }

  async function runFixtureBatches<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
    const values: T[] = [];
    for (let offset = 0; offset < tasks.length; offset += 3) {
      const settled = await Promise.allSettled(tasks.slice(offset, offset + 3).map((task) => task()));
      const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure !== undefined) throw failure.reason;
      values.push(...settled.map((result) => (result as PromiseFulfilledResult<T>).value));
    }
    return values;
  }

  const simpleResult = (user: User): ResultInput => ({
    user,
    nickname: `${user.nickname}-snapshot`,
    avatarUrl: 'preset-snapshot',
    rawProfit: 0n,
    roomFeeShare: 0n,
    otherFeeShare: 0n,
    afterFeeProfit: 0n,
    rakeAmount: 0n,
    finalAmount: 0n
  });

  async function cleanOwnedFixtures(): Promise<void> {
    const games = await prisma.game.findMany({
      where: { name: { startsWith: prefix } },
      select: { id: true, createdById: true, settledById: true, players: { select: { userId: true } } }
    });
    const ownedUsers = new Set([admin, superAdmin, participant, opponent, thirdPlayer, tieAlpha, tieBeta, outsider]
      .filter((user): user is User => user !== undefined).map(({ id }) => id));
    if (games.some((game) => game.createdById !== admin.id || game.settledById !== admin.id ||
      game.players.some(({ userId }) => !ownedUsers.has(userId)))) {
      throw new Error('History aggregation fixture ownership graph is not closed');
    }
    const gameIds = games.map(({ id }) => id);
    if (gameIds.length === 0) return;
    const playerIds = (await prisma.gamePlayer.findMany({
      where: { gameId: { in: gameIds } }, select: { id: true }
    })).map(({ id }) => id);
    await prisma.settlementFeeAllocation.deleteMany({ where: { gamePlayerId: { in: playerIds } } });
    await prisma.settlementResult.deleteMany({ where: { gamePlayerId: { in: playerIds } } });
    await prisma.settlement.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.gamePlayer.deleteMany({ where: { gameId: { in: gameIds } } });
    await prisma.game.deleteMany({ where: { id: { in: gameIds } } });
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.CSRF_SECRET = randomUUID();
    process.env.BOOTSTRAP_ADMIN_USERNAME = `${prefix}-bootstrap`;
    process.env.BOOTSTRAP_ADMIN_NICKNAME = prefix;
    process.env.BOOTSTRAP_ADMIN_PASSWORD = password;
    app = await createApp();
    prisma = app.get(PrismaService);
    await app.init();
    passwordHash = await argon2.hash(password);
    admin = await seedUser('admin', Role.ADMIN, '管理员');
    superAdmin = await seedUser('super-admin', Role.SUPER_ADMIN, '超级管理员');
    participant = await seedUser('participant', Role.USER, '天一');
    opponent = await seedUser('opponent', Role.USER, '老王');
    thirdPlayer = await seedUser('third', Role.USER, '小陈');
    tieAlpha = await seedUser('tie-alpha', Role.USER, 'alpha');
    tieBeta = await seedUser('tie-beta', Role.USER, 'Beta');
    outsider = await seedUser('outsider', Role.USER, '局外人');
    adminAuth = loginFrom(await request(app.getHttpServer())
      .post('/api/auth/login').send({ username: admin.username, password }).expect(201));
    superAdminAuth = loginFrom(await request(app.getHttpServer())
      .post('/api/auth/login').send({ username: superAdmin.username, password }).expect(201));
    participantAuth = loginFrom(await request(app.getHttpServer())
      .post('/api/auth/login').send({ username: participant.username, password }).expect(201));
  }, 120_000);

  beforeEach(async () => cleanOwnedFixtures());

  afterAll(async () => {
    if (prisma !== undefined) {
      await cleanOwnedFixtures();
      const users = await prisma.user.findMany({
        where: { normalizedUsername: { startsWith: normalize(prefix) } }, select: { id: true }
      });
      const userIds = users.map(({ id }) => id);
      await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
      await prisma.authSession.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (app !== undefined) await app.close();
  }, 120_000);

  it('keeps settlement names immutable while returning each player current avatar and exact component sums', async () => {
    // Break caught: aggregation exposes a stale raw avatar snapshot instead of the player's current usable avatar URL.
    const second = await seedCompleted('visible-second', new Date('2026-08-18T12:00:00.000Z'), [
      { user: participant, nickname: '天一', avatarUrl: 'snapshot-tianyi', rawProfit: 1420n, roomFeeShare: 220n, otherFeeShare: 100n, afterFeeProfit: 1100n, rakeAmount: 140n, finalAmount: 960n },
      { user: thirdPlayer, nickname: '小陈', avatarUrl: 'snapshot-xiaochen', rawProfit: -1420n, roomFeeShare: 0n, otherFeeShare: 0n, afterFeeProfit: -1420n, rakeAmount: 0n, finalAmount: -1420n },
      { user: tieAlpha, nickname: 'alpha', avatarUrl: 'snapshot-alpha', rawProfit: 0n, roomFeeShare: 0n, otherFeeShare: 0n, afterFeeProfit: 0n, rakeAmount: 0n, finalAmount: 10n }
    ]);
    const first = await seedCompleted('visible-first', new Date('2026-08-17T12:00:00.000Z'), [
      { user: participant, nickname: '天一', avatarUrl: 'snapshot-tianyi', rawProfit: 2000n, roomFeeShare: 300n, otherFeeShare: 40n, afterFeeProfit: 1660n, rakeAmount: 160n, finalAmount: 1500n },
      { user: opponent, nickname: '老王', avatarUrl: 'snapshot-laowang', rawProfit: -2000n, roomFeeShare: 0n, otherFeeShare: 0n, afterFeeProfit: -2000n, rakeAmount: 0n, finalAmount: -2000n },
      { user: tieBeta, nickname: 'Beta', avatarUrl: 'snapshot-beta', rawProfit: 0n, roomFeeShare: 0n, otherFeeShare: 0n, afterFeeProfit: 0n, rakeAmount: 0n, finalAmount: 10n }
    ]);
    await prisma.user.update({
      where: { id: participant.id },
      data: {
        nickname: '已修改用户',
        activeNormalizedNickname: normalize('已修改用户'),
        avatarValue: 'preset-24'
      }
    });

    const response = await aggregateAs(participantAuth, { gameIds: [first, second] }).expect(200);
    expect(allPlayerAggregationSchema.parse(response.body)).toEqual(response.body);
    expect(response.body.gameIds).toEqual([second, first]);
    expect(response.body).toMatchObject({ gameCount: 2, playerCount: 5 });
    expect(response.body.players.map(({ nickname }: { nickname: string }) => nickname))
      .toEqual(['天一', 'alpha', 'Beta', '小陈', '老王']);
    const playerA = response.body.players.find(({ userId }: { userId: string }) => userId === participant.id);
    expect(playerA).toMatchObject({
      nickname: '天一', avatarUrl: '/avatars/preset-24.webp', gamesPlayed: 2, wins: 2, losses: 0,
      rawProfit: '3420', roomFeeShare: '520', otherFeeShare: '140', afterFeeProfit: '2760', rakeAmount: '300', finalAmount: '2460'
    });
    expect(BigInt(playerA.afterFeeProfit)).toBe(
      BigInt(playerA.rawProfit) - BigInt(playerA.roomFeeShare) - BigInt(playerA.otherFeeShare)
    );
    expect(playerA.games).toEqual([
      { gameId: second, gameName: `${prefix}-visible-second`, completedAt: '2026-08-18T12:00:00.000Z', finalAmount: '960' },
      { gameId: first, gameName: `${prefix}-visible-first`, completedAt: '2026-08-17T12:00:00.000Z', finalAmount: '1500' }
    ]);
    expect(response.body.players.find(({ userId }: { userId: string }) => userId === opponent.id)).toMatchObject({
      rawProfit: '-2000', wins: 0, losses: 1, finalAmount: '-2000'
    });
    expect(response.body.players.find(({ userId }: { userId: string }) => userId === tieAlpha.id)).toMatchObject({
      rawProfit: '0', wins: 0, losses: 0, finalAmount: '10'
    });
    expect(response.body.players.find(({ userId }: { userId: string }) => userId === tieBeta.id)).toMatchObject({
      rawProfit: '0', wins: 0, losses: 0, finalAmount: '10'
    });
  });

  it('orders same-timestamp per-player games by game ID descending', async () => {
    // Break caught: tied completed timestamps have no deterministic game-id secondary order.
    const completedAt = new Date('2026-08-18T12:00:00.000Z');
    const first = await seedCompleted('same-time-first', completedAt, [simpleResult(participant)]);
    const second = await seedCompleted('same-time-second', completedAt, [simpleResult(participant)]);
    const response = await aggregateAs(participantAuth, { gameIds: [first, second] }).expect(200);
    const player = response.body.players.find(({ userId }: { userId: string }) => userId === participant.id);
    expect(player.games.map(({ gameId }: { gameId: string }) => gameId))
      .toEqual([first, second].sort((left, right) => right.localeCompare(left)));
  });

  it('rejects the entire ordinary-user request when any selected completed game is out of scope', async () => {
    // Break caught: a forbidden game id is silently filtered instead of denying the entire request.
    const visible = await seedCompleted('visible', new Date('2026-08-18T12:00:00.000Z'), [simpleResult(participant)]);
    const hidden = await seedCompleted('hidden', new Date('2026-08-17T12:00:00.000Z'), [simpleResult(outsider)]);
    await aggregateAs(participantAuth, { gameIds: [visible, hidden] }).expect(403)
      .expect(({ body }) => expect(body.code).toBe('HISTORY_SCOPE_DENIED'));
    await aggregateAs(participantAuth, { gameIds: [visible] }).expect(200)
      .expect(({ body }) => expect(body.gameIds).toEqual([visible]));
  });

  it('keeps admin quick filters global while user quick filters remain participant-scoped', async () => {
    // Break caught: non-user roles inherit participant scope, or user quick filters disclose another table.
    const hidden = await seedCompleted('admin-only', new Date(), [{
      ...simpleResult(outsider), nickname: '永久局外人', avatarUrl: 'snapshot-deleted-user', finalAmount: 1n
    }]);
    await prisma.user.update({
      where: { id: outsider.id },
      data: { nickname: '删除后的昵称', activeNormalizedNickname: null, deletedAt: new Date(), isActive: false }
    });
    const admin = await aggregateAs(adminAuth, { filter: { kind: 'LAST_30_DAYS' } }).expect(200);
    expect(admin.body.gameIds).toContain(hidden);
    expect(admin.body.players).toEqual([expect.objectContaining({
      userId: outsider.id, nickname: '永久局外人', avatarUrl: '/avatars/preset-01.webp',
      gamesPlayed: 1, wins: 0, losses: 0, finalAmount: '1'
    })]);
    const superAdmin = await aggregateAs(superAdminAuth, { filter: { kind: 'RECENT_10' } }).expect(200);
    expect(superAdmin.body.gameIds).toContain(hidden);
    await aggregateAs(participantAuth, { filter: { kind: 'LAST_30_DAYS' } }).expect(200)
      .expect(({ body }) => expect(body.gameIds).not.toContain(hidden));
    await aggregateAs(adminAuth, { gameIds: [hidden] }).expect(200)
      .expect(({ body }) => expect(body.players).toEqual([expect.objectContaining({
        userId: outsider.id, nickname: '永久局外人', avatarUrl: '/avatars/preset-01.webp',
        gamesPlayed: 1, wins: 0, losses: 0, finalAmount: '1'
      })]));
  });

  it('returns a zero aggregation for an empty explicit selection and rejects duplicate, malformed, and over-limit game IDs', async () => {
    // Break caught: empty selection is confused with global scope, or malformed selection input reaches authorization queries.
    await aggregateAs(adminAuth, { gameIds: [] }).expect(200).expect(({ body }) => {
      expect(body).toEqual({ gameIds: [], gameCount: 0, playerCount: 0, players: [] });
    });
    const game = await seedCompleted('validation', new Date('2026-08-18T12:00:00.000Z'), [simpleResult(participant)]);
    for (const body of [
      { gameIds: [game, game] },
      { gameIds: ['not canonical'] },
      { gameIds: Array.from({ length: 101 }, (_, index) => `g${index.toString().padStart(3, '0')}`) },
      { gameIds: [game], extra: true }
    ]) {
      await aggregateAs(adminAuth, body).expect(400)
        .expect(({ body: responseBody }) => expect(responseBody.code).toBe('VALIDATION_ERROR'));
    }
  });

  it('resolves every quick filter with UTC date boundaries before authorizing and aggregating', async () => {
    // Break caught: quick filters use local-time boundaries, exclude an inclusive custom endpoint, or bypass participant scope.
    const now = new Date();
    const recent = await runFixtureBatches(Array.from({ length: 31 }, (_, index) => () => seedCompleted(
      `recent-${index}`,
      new Date(now.getTime() - index * 60_000),
      [simpleResult(participant)]
    )));
    const customStart = new Date('2026-08-01T00:00:00.000Z');
    const customEnd = new Date('2026-08-02T00:00:00.000Z');
    const [inside30, outside30, inside90, outside90, customAtStart, customAtEnd, , forbidden] = await runFixtureBatches([
      () => seedCompleted('inside-30', new Date(now.getTime() - (30 * 86_400_000) + 60_000), [simpleResult(participant)]),
      () => seedCompleted('outside-30', new Date(now.getTime() - (30 * 86_400_000) - 60_000), [simpleResult(participant)]),
      () => seedCompleted('inside-90', new Date(now.getTime() - (90 * 86_400_000) + 60_000), [simpleResult(participant)]),
      () => seedCompleted('outside-90', new Date(now.getTime() - (90 * 86_400_000) - 60_000), [simpleResult(participant)]),
      () => seedCompleted('custom-start', customStart, [simpleResult(participant)]),
      () => seedCompleted('custom-end', customEnd, [simpleResult(participant)]),
      () => seedCompleted('custom-outside', new Date('2026-08-02T00:00:00.001Z'), [simpleResult(participant)]),
      () => seedCompleted('filter-forbidden', new Date(now.getTime() - 30_000), [simpleResult(outsider)])
    ]);

    const recent10 = await aggregateAs(participantAuth, { filter: { kind: 'RECENT_10' } }).expect(200);
    expect(recent10.body.gameIds).toHaveLength(10);
    expect(recent10.body.gameIds).toEqual(recent.slice(0, 10));
    const recent30 = await aggregateAs(participantAuth, { filter: { kind: 'RECENT_30' } }).expect(200);
    expect(recent30.body.gameIds).toHaveLength(30);
    expect(recent30.body.gameIds).toEqual(recent.slice(0, 30));
    const last30 = await aggregateAs(participantAuth, { filter: { kind: 'LAST_30_DAYS' } }).expect(200);
    expect(last30.body.gameIds).toContain(inside30);
    expect(last30.body.gameIds).not.toContain(outside30);
    const last90 = await aggregateAs(participantAuth, { filter: { kind: 'LAST_90_DAYS' } }).expect(200);
    expect(last90.body.gameIds).toContain(inside90);
    expect(last90.body.gameIds).not.toContain(outside90);
    expect(last90.body.gameIds).not.toContain(forbidden);
    const custom = await aggregateAs(participantAuth, {
      filter: { kind: 'CUSTOM_DATE_RANGE', startAt: customStart.toISOString(), endAt: customEnd.toISOString() }
    }).expect(200);
    expect(custom.body.gameIds).toEqual([customAtEnd, customAtStart]);
  }, 300_000);

  it('builds a Shanghai calendar-month ranking from only games the requesting user joined', async () => {
    // Break caught: monthly rankings use UTC month edges or let an administrator see tables they did not join.
    const result = (user: User, finalAmount: bigint): ResultInput => ({
      ...simpleResult(user),
      rawProfit: finalAmount,
      afterFeeProfit: finalAmount,
      finalAmount
    });
    const beforeMonth = await seedCompleted('month-before', new Date('2026-07-31T15:59:59.999Z'), [
      result(admin, 50n), result(opponent, -50n)
    ]);
    const atMonthStart = await seedCompleted('month-start', new Date('2026-07-31T16:00:00.000Z'), [
      result(admin, 1200n), result(opponent, -1200n)
    ]);
    const atMonthEnd = await seedCompleted('month-end', new Date('2026-08-31T15:59:59.999Z'), [
      result(admin, -200n), result(opponent, 200n)
    ]);
    const atNextMonth = await seedCompleted('month-after', new Date('2026-08-31T16:00:00.000Z'), [
      result(admin, 90n), result(opponent, -90n)
    ]);
    const unrelated = await seedCompleted('month-unrelated', new Date('2026-08-15T12:00:00.000Z'), [
      result(participant, 500n), result(thirdPlayer, -500n)
    ]);

    const response = await aggregateAs(adminAuth, {
      filter: { kind: 'MY_MONTH', year: 2026, month: 8 }
    }).expect(200);

    expect(allPlayerAggregationSchema.parse(response.body)).toEqual(response.body);
    expect(response.body.gameIds).toEqual([atMonthEnd, atMonthStart]);
    expect(response.body.gameIds).not.toContain(beforeMonth);
    expect(response.body.gameIds).not.toContain(atNextMonth);
    expect(response.body.gameIds).not.toContain(unrelated);
    expect(response.body).toMatchObject({ gameCount: 2, playerCount: 2 });
    expect(response.body.players.map(({ userId, finalAmount }: { userId: string; finalAmount: string }) => ({ userId, finalAmount })))
      .toEqual([
        { userId: admin.id, finalAmount: '1000' },
        { userId: opponent.id, finalAmount: '-1000' }
      ]);
  });

  it('rejects invalid quick filter date ranges and detects derived signed BIGINT overflow', async () => {
    // Break caught: inverted or offset-less dates become arbitrary scopes, or aggregate sums escape the signed BIGINT contract.
    for (const filter of [
      { kind: 'CUSTOM_DATE_RANGE', startAt: '2026-08-02T00:00:00.000Z', endAt: '2026-08-01T00:00:00.000Z' },
      { kind: 'CUSTOM_DATE_RANGE', startAt: '2026-08-01T00:00:00', endAt: '2026-08-02T00:00:00.000Z' },
      { kind: 'MY_MONTH', year: 2026, month: 0 },
      { kind: 'MY_MONTH', year: 2026, month: 13 },
      { kind: 'UNKNOWN' }
    ]) {
      await aggregateAs(adminAuth, { filter }).expect(400)
        .expect(({ body }) => expect(body.code).toBe('VALIDATION_ERROR'));
    }
    const maximum = 9_223_372_036_854_775_807n;
    const first = await seedCompleted('overflow-first', new Date('2026-08-18T12:00:00.000Z'), [{
      ...simpleResult(participant), rawProfit: maximum, afterFeeProfit: maximum, finalAmount: maximum
    }]);
    const second = await seedCompleted('overflow-second', new Date('2026-08-17T12:00:00.000Z'), [{
      ...simpleResult(participant), rawProfit: maximum, afterFeeProfit: maximum, finalAmount: maximum
    }]);
    await aggregateAs(participantAuth, { gameIds: [first, second] }).expect(400)
      .expect(({ body }) => expect(body.code).toBe('VALIDATION_ERROR'));
  });
});
