import type { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import request, { type Response } from 'supertest';
import { beforeEach } from 'vitest';
import { GameStatus, Role, type User } from '../src/generated/prisma/client.js';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { requireAuthorizedTestDatabase } from './support/authorized-test-database.js';

requireAuthorizedTestDatabase();

const runId = randomUUID().replaceAll('-', '').slice(0, 8);
const prefix = `history-${runId}`;
const password = `${randomBytes(18).toString('base64url')}Aa1!`;
const normalize = (value: string) => value.trim().normalize('NFKC').toLocaleLowerCase('zh-CN');

function cookieFrom(response: Response): string {
  const value = Array.isArray(response.headers['set-cookie'])
    ? response.headers['set-cookie'][0]
    : response.headers['set-cookie'];
  return value!.split(';', 1)[0]!;
}

describe.sequential('immutable completed-game history', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: User;
  let member: User;
  let outsider: User;
  let adminCookie: string;
  let memberCookie: string;
  const read = (cookie: string, url: string) => request(app.getHttpServer()).get(url).set('Cookie', cookie);

  async function seedUser(suffix: string, role: Role): Promise<User> {
    const username = `${prefix}-${suffix}`;
    const nickname = `历史-${runId}-${suffix}`;
    return prisma.user.create({
      data: {
        username,
        normalizedUsername: normalize(username),
        nickname,
        activeNormalizedNickname: normalize(nickname),
        passwordHash: await argon2.hash(password),
        role,
        avatarValue: 'preset-01'
      }
    });
  }

  async function seedCompleted(index: number, includeMember: boolean, completedAt: Date): Promise<string> {
    const startedAt = new Date(completedAt.getTime() - 3_000_000);
    const stoppedAt = new Date(completedAt.getTime() - 1_000_000);
    const game = await prisma.game.create({
      data: {
        name: `${prefix}-detail-${index}`,
        handPrice: 300n,
        status: GameStatus.COMPLETED,
        createdById: admin.id,
        startedAt,
        stoppedAt,
        completedAt,
        settledById: admin.id
      }
    });
    const first = includeMember ? member : admin;
    const players = await Promise.all([first, outsider].map((user, seatNo) => prisma.gamePlayer.create({
      data: {
        gameId: game.id,
        userId: user.id,
        nicknameSnapshot: `${user.nickname}-snapshot-${index}`,
        avatarKindSnapshot: user.avatarKind,
        avatarValueSnapshot: `preset-0${seatNo + 1}`,
        seatNo: seatNo + 1,
        firstBuyinAt: startedAt
      }
    })));
    const settlement = await prisma.settlement.create({
      data: {
        gameId: game.id,
        buyInTotal: 600n,
        cashOutTotal: 600n,
        roomFee: 20n,
        otherFee: 10n,
        otherFeeNote: `note-${index}`,
        rakeThresholdUsed: 1000n,
        rakeBpsUsed: 1000,
        settingsVersionUsed: 1,
        rakeTotal: 0n,
        finalTotal: -30n,
        settledById: admin.id,
        settledByNicknameSnapshot: admin.nickname,
        lockedAt: completedAt
      }
    });
    await prisma.settlementResult.createMany({
      data: players.map((player, seatNo) => ({
        settlementId: settlement.id,
        gamePlayerId: player.id,
        buyIn: 300n,
        cashOut: seatNo === 0 ? 600n : 0n,
        rawProfit: seatNo === 0 ? 300n : -300n,
        roomFeeShare: seatNo === 0 ? 20n : 0n,
        otherFeeShare: seatNo === 0 ? 10n : 0n,
        afterFeeProfit: seatNo === 0 ? 270n : -300n,
        rakeEligible: false,
        rakeAmount: 0n,
        finalAmount: seatNo === 0 ? 270n : -300n
      }))
    });
    return game.id;
  }

  async function seedListGames(
    count: number,
    tag: string,
    includeMember: boolean,
    completedAt: (index: number) => Date
  ): Promise<string[]> {
    const rows = Array.from({ length: count }, (_, index) => {
      const serial = index.toString().padStart(3, '0');
      return {
        gameId: `h${runId}${tag}${serial}`,
        settlementId: `s${runId}${tag}${serial}`,
        playerId: `p${runId}${tag}${serial}`,
        completedAt: completedAt(index)
      };
    });
    await prisma.game.createMany({
      data: rows.map((row) => ({
        id: row.gameId,
        name: `${prefix}-${tag}-${row.gameId}`,
        handPrice: 300n,
        status: GameStatus.COMPLETED,
        createdById: admin.id,
        startedAt: new Date(row.completedAt.getTime() - 2_000),
        stoppedAt: new Date(row.completedAt.getTime() - 1_000),
        completedAt: row.completedAt,
        settledById: admin.id
      }))
    });
    if (includeMember) {
      await prisma.gamePlayer.createMany({
        data: rows.map((row) => ({
          id: row.playerId,
          gameId: row.gameId,
          userId: member.id,
          nicknameSnapshot: member.nickname,
          avatarKindSnapshot: member.avatarKind,
          avatarValueSnapshot: member.avatarValue,
          seatNo: 1,
          firstBuyinAt: new Date(row.completedAt.getTime() - 2_000)
        }))
      });
    }
    await prisma.settlement.createMany({
      data: rows.map((row) => ({
        id: row.settlementId,
        gameId: row.gameId,
        buyInTotal: 0n,
        cashOutTotal: 0n,
        roomFee: 0n,
        otherFee: 0n,
        otherFeeNote: '',
        rakeThresholdUsed: 1000n,
        rakeBpsUsed: 1000,
        settingsVersionUsed: 1,
        rakeTotal: 0n,
        finalTotal: 0n,
        settledById: admin.id,
        settledByNicknameSnapshot: admin.nickname,
        lockedAt: row.completedAt
      }))
    });
    return rows.map(({ gameId }) => gameId);
  }

  async function cleanOwnedGames(): Promise<void> {
    const games = await prisma.game.findMany({
      where: { name: { startsWith: prefix } },
      select: { id: true, createdById: true }
    });
    if (games.some(({ createdById }) => createdById !== admin.id)) {
      throw new Error('History fixture ownership graph is not closed');
    }
    const gameIds = games.map(({ id }) => id);
    if (gameIds.length === 0) return;
    const playerIds = (await prisma.gamePlayer.findMany({
      where: { gameId: { in: gameIds } }, select: { id: true }
    })).map(({ id }) => id);
    if (playerIds.length > 0) {
      await prisma.settlementFeeAllocation.deleteMany({ where: { gamePlayerId: { in: playerIds } } });
      await prisma.settlementResult.deleteMany({ where: { gamePlayerId: { in: playerIds } } });
    }
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
    admin = await seedUser('admin', Role.ADMIN);
    member = await seedUser('member', Role.USER);
    outsider = await seedUser('outsider', Role.USER);
    adminCookie = cookieFrom(await request(app.getHttpServer())
      .post('/api/auth/login').send({ username: admin.username, password }).expect(201));
    memberCookie = cookieFrom(await request(app.getHttpServer())
      .post('/api/auth/login').send({ username: member.username, password }).expect(201));
  }, 120_000);

  beforeEach(async () => {
    await cleanOwnedGames();
    admin = await prisma.user.update({
      where: { id: admin.id },
      data: { nickname: `历史-${runId}-admin`, activeNormalizedNickname: normalize(`历史-${runId}-admin`) }
    });
    member = await prisma.user.update({ where: { id: member.id }, data: { avatarValue: 'preset-01' } });
    outsider = await prisma.user.update({ where: { id: outsider.id }, data: { avatarValue: 'preset-01' } });
  });

  afterAll(async () => {
    if (prisma !== undefined) {
      await cleanOwnedGames();
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

  it('gives administrators global scope and participants full-table detail with current player avatars', async () => {
    // Break caught: history leaks another table, drops opponents, loses hand price, or keeps a stale avatar after a profile update.
    const completedAt = new Date('2026-08-18T00:00:00.000Z');
    const visible = await seedCompleted(1, true, completedAt);
    const hidden = await seedCompleted(2, false, new Date(completedAt.getTime() - 1_000));
    const settledBySnapshot = admin.nickname;
    member = await prisma.user.update({ where: { id: member.id }, data: { avatarValue: 'preset-24' } });
    await prisma.user.update({
      where: { id: admin.id },
      data: { nickname: `已修改-${runId}`, activeNormalizedNickname: normalize(`已修改-${runId}`) }
    });

    const userList = await read(memberCookie, '/api/history').expect(200);
    expect(userList.body.items.map(({ gameId }: { gameId: string }) => gameId)).toEqual([visible]);
    expect(userList.body.items[0]).toMatchObject({
      gameId: visible,
      settledByNickname: settledBySnapshot,
      myFinalAmount: '270'
    });
    const adminList = await read(adminCookie, '/api/history').expect(200);
    expect(adminList.body.items.map(({ gameId }: { gameId: string }) => gameId)).toEqual([visible, hidden]);
    expect(adminList.body.items.find(({ gameId }: { gameId: string }) => gameId === visible)).toMatchObject({
      myFinalAmount: null
    });

    const detail = await read(memberCookie, `/api/history/${visible}`).expect(200);
    expect(detail.body).toMatchObject({
      immutable: true,
      completedAt: completedAt.toISOString(),
      settledByNickname: settledBySnapshot,
      otherFeeNote: 'note-1',
      totals: {
        buyIn: '600', cashOut: '600', roomFee: '20', otherFee: '10', rake: '0', final: '-30'
      },
      game: {
        name: `${prefix}-detail-1`,
        handPrice: '300',
        startedAt: new Date(completedAt.getTime() - 3_000_000).toISOString(),
        stoppedAt: new Date(completedAt.getTime() - 1_000_000).toISOString(),
        durationSeconds: 2000
      }
    });
    expect(detail.body.players).toHaveLength(2);
    expect(detail.body.players[0]).toMatchObject({
      nickname: `${member.nickname}-snapshot-1`,
      avatarValue: 'preset-24',
      buyIn: '300', cashOut: '600', rawProfit: '300', roomFeeShare: '20',
      otherFeeShare: '10', afterFeeProfit: '270', rakeAmount: '0', finalAmount: '270'
    });
    expect(detail.body.players[1]).toMatchObject({
      nickname: `${outsider.nickname}-snapshot-1`,
      buyIn: '300', cashOut: '0', rawProfit: '-300', finalAmount: '-300'
    });
    await read(memberCookie, `/api/history/${hidden}`).expect(404)
      .expect(({ body }) => expect(body.code).toBe('HISTORY_SCOPE_DENIED'));
  }, 120_000);

  it('omits completed games that have no permanent settlement for administrators and participants', async () => {
    // Break caught: a nullable settlement is force-dereferenced while mapping the history list.
    const completedAt = new Date('2026-08-18T00:30:00.000Z');
    const visible = await seedCompleted(3, true, completedAt);
    const orphan = await prisma.game.create({
      data: {
        name: `${prefix}-completed-without-settlement`,
        handPrice: 300n,
        status: GameStatus.COMPLETED,
        createdById: admin.id,
        startedAt: new Date(completedAt.getTime() + 1_000),
        stoppedAt: new Date(completedAt.getTime() + 2_000),
        completedAt: new Date(completedAt.getTime() + 3_000),
        settledById: admin.id
      }
    });
    await prisma.gamePlayer.create({
      data: {
        gameId: orphan.id,
        userId: member.id,
        nicknameSnapshot: member.nickname,
        avatarKindSnapshot: member.avatarKind,
        avatarValueSnapshot: member.avatarValue,
        seatNo: 1,
        firstBuyinAt: completedAt
      }
    });

    const adminList = await read(adminCookie, '/api/history').expect(200);
    expect(adminList.body.items.map(({ gameId }: { gameId: string }) => gameId)).toEqual([visible]);
    const memberList = await read(memberCookie, '/api/history').expect(200);
    expect(memberList.body.items.map(({ gameId }: { gameId: string }) => gameId)).toEqual([visible]);
  });

  it('uses default limit 10 and stable opaque cursor ordering across tied timestamps', async () => {
    // Break caught: a tied completedAt boundary duplicates or skips games between cursor pages.
    const sameTime = new Date('2026-08-18T01:00:00.000Z');
    const ids = await seedListGames(12, 'tied', true, () => sameTime);
    const expected = [...ids].sort((left, right) => right.localeCompare(left));

    const first = await read(memberCookie, '/api/history').expect(200);
    expect(first.body.items.map(({ gameId }: { gameId: string }) => gameId)).toEqual(expected.slice(0, 10));
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await read(
      memberCookie,
      `/api/history?cursor=${encodeURIComponent(first.body.nextCursor)}`
    ).expect(200);
    expect(second.body.items.map(({ gameId }: { gameId: string }) => gameId)).toEqual(expected.slice(10));
    expect(second.body.nextCursor).toBeNull();
    expect(new Set([...first.body.items, ...second.body.items]
      .map(({ gameId }: { gameId: string }) => gameId)).size).toBe(12);
  });

  it('caps administrator history requests at 50 rows', async () => {
    // Break caught: a caller can bypass the maximum history page size with a larger limit.
    const base = new Date('2026-08-18T02:00:00.000Z');
    const ids = await seedListGames(51, 'cap', false, (index) => new Date(base.getTime() - index));
    const first = await read(adminCookie, '/api/history?limit=99').expect(200);
    expect(first.body.items).toHaveLength(50);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await read(
      adminCookie,
      `/api/history?limit=99&cursor=${encodeURIComponent(first.body.nextCursor)}`
    ).expect(200);
    expect(second.body.items.map(({ gameId }: { gameId: string }) => gameId)).toEqual([ids[50]]);
    expect(second.body.nextCursor).toBeNull();
  });

  it('distinguishes canonical missing IDs from malformed IDs and rejects malformed queries', async () => {
    // Break caught: malformed public identifiers or cursors reach the database as ordinary misses.
    await read(memberCookie, `/api/history/c${'a'.repeat(24)}`).expect(404)
      .expect(({ body }) => expect(body.code).toBe('HISTORY_SCOPE_DENIED'));
    await read(memberCookie, '/api/history/not canonical').expect(400)
      .expect(({ body }) => expect(body.code).toBe('VALIDATION_ERROR'));
    await read(memberCookie, '/api/history?cursor=not-base64').expect(400)
      .expect(({ body }) => expect(body.code).toBe('VALIDATION_ERROR'));
    await read(memberCookie, '/api/history?limit=0').expect(400)
      .expect(({ body }) => expect(body.code).toBe('VALIDATION_ERROR'));
  });
});
