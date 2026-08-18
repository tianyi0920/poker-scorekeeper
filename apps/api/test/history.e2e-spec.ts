import type { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import request, { type Response } from 'supertest';
import { GameStatus, Role, type User } from '../src/generated/prisma/client.js';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const databaseName = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
if (databaseName !== 'poker_scorekeeper_test') throw new Error('History E2E requires poker_scorekeeper_test');
const runId = randomUUID().replaceAll('-', '').slice(0, 8);
const prefix = `history-${runId}`;
const password = `${randomBytes(18).toString('base64url')}Aa1!`;
const normalize = (value: string) => value.trim().toLocaleLowerCase('zh-CN');

function cookieFrom(response: Response): string {
  const value = Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'][0] : response.headers['set-cookie'];
  return value!.split(';', 1)[0]!;
}

describe.sequential('immutable completed-game history', () => {
  let app: INestApplication; let prisma: PrismaService; let admin: User; let member: User; let outsider: User;
  let adminCookie: string; let memberCookie: string;
  const read = (cookie: string, url: string) => request(app.getHttpServer()).get(url).set('Cookie', cookie);

  async function seedUser(suffix: string, role: Role): Promise<User> {
    const username = `${prefix}-${suffix}`; const nickname = `历史-${runId}-${suffix}`;
    return prisma.user.create({ data: { username, normalizedUsername: normalize(username), nickname, activeNormalizedNickname: normalize(nickname), passwordHash: await argon2.hash(password), role, avatarValue: 'preset-01' } });
  }

  async function seedCompleted(index: number, includeMember: boolean, completedAt: Date): Promise<string> {
    const startedAt = new Date(completedAt.getTime() - 3_000_000); const stoppedAt = new Date(completedAt.getTime() - 1_000_000);
    const game = await prisma.game.create({ data: { name: `${prefix}-${index}`, handPrice: 300n, status: GameStatus.COMPLETED, createdById: admin.id, startedAt, stoppedAt, completedAt, settledById: admin.id } });
    const first = includeMember ? member : admin;
    const players = await Promise.all([first, outsider].map((user, seatNo) => prisma.gamePlayer.create({ data: { gameId: game.id, userId: user.id, nicknameSnapshot: `${user.nickname}-snapshot-${index}`, avatarKindSnapshot: user.avatarKind, avatarValueSnapshot: `preset-0${seatNo + 1}`, seatNo: seatNo + 1, firstBuyinAt: startedAt } })));
    const settlement = await prisma.settlement.create({ data: { gameId: game.id, buyInTotal: 600n, cashOutTotal: 600n, roomFee: 20n, otherFee: 10n, otherFeeNote: `note-${index}`, rakeThresholdUsed: 1000n, rakeBpsUsed: 1000, settingsVersionUsed: 1, rakeTotal: 0n, finalTotal: -30n, settledById: admin.id, lockedAt: completedAt } });
    await prisma.settlementResult.createMany({ data: players.map((player, seatNo) => ({ settlementId: settlement.id, gamePlayerId: player.id, buyIn: 300n, cashOut: seatNo === 0 ? 600n : 0n, rawProfit: seatNo === 0 ? 300n : -300n, roomFeeShare: seatNo === 0 ? 20n : 0n, otherFeeShare: seatNo === 0 ? 10n : 0n, afterFeeProfit: seatNo === 0 ? 270n : -300n, rakeEligible: false, rakeAmount: 0n, finalAmount: seatNo === 0 ? 270n : -300n })) });
    return game.id;
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'; process.env.CSRF_SECRET = randomUUID(); process.env.BOOTSTRAP_ADMIN_USERNAME = `${prefix}-bootstrap`; process.env.BOOTSTRAP_ADMIN_NICKNAME = prefix; process.env.BOOTSTRAP_ADMIN_PASSWORD = password;
    app = await createApp(); prisma = app.get(PrismaService); await app.init(); admin = await seedUser('admin', Role.ADMIN); member = await seedUser('member', Role.USER); outsider = await seedUser('outsider', Role.USER);
    adminCookie = cookieFrom(await request(app.getHttpServer()).post('/api/auth/login').send({ username: admin.username, password }).expect(201)); memberCookie = cookieFrom(await request(app.getHttpServer()).post('/api/auth/login').send({ username: member.username, password }).expect(201));
  }, 30_000);
  afterAll(async () => {
    const games = await prisma.game.findMany({ where: { name: { startsWith: prefix } }, select: { id: true } }); const ids = games.map((x) => x.id); const players = await prisma.gamePlayer.findMany({ where: { gameId: { in: ids } }, select: { id: true } }); const pids = players.map((x) => x.id);
    await prisma.settlementResult.deleteMany({ where: { gamePlayerId: { in: pids } } }); await prisma.settlement.deleteMany({ where: { gameId: { in: ids } } }); await prisma.gamePlayer.deleteMany({ where: { gameId: { in: ids } } }); await prisma.game.deleteMany({ where: { id: { in: ids } } }); await prisma.authSession.deleteMany({ where: { userId: { in: [admin.id, member.id, outsider.id] } } }); await prisma.user.deleteMany({ where: { id: { in: [admin.id, member.id, outsider.id] } } }); await app.close();
  }, 30_000);

  it('scopes, paginates, and renders immutable full-table snapshots', async () => {
    const sameTime = new Date('2026-08-18T00:00:00.000Z'); const ids: string[] = [];
    for (let index = 0; index < 11; index += 1) ids.push(await seedCompleted(index, true, index < 2 ? sameTime : new Date(sameTime.getTime() - index * 1_000)));
    const hidden = await seedCompleted(99, false, new Date(sameTime.getTime() - 20_000));
    const first = await read(memberCookie, '/api/history').expect(200); expect(first.body.items).toHaveLength(10); expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await read(memberCookie, `/api/history?cursor=${encodeURIComponent(first.body.nextCursor)}`).expect(200); expect(second.body.items).toHaveLength(1); expect(new Set([...first.body.items, ...second.body.items].map((item: { gameId: string }) => item.gameId)).size).toBe(11);
    const adminList = await read(adminCookie, '/api/history?limit=99').expect(200); expect(adminList.body.items).toHaveLength(12);
    const detail = await read(memberCookie, `/api/history/${ids[0]}`).expect(200); expect(detail.body).toMatchObject({ immutable: true, completedAt: sameTime.toISOString(), settledByNickname: admin.nickname, otherFeeNote: 'note-0', game: { durationSeconds: 2000 } }); expect(detail.body.players).toHaveLength(2); expect(detail.body.players[0]).toMatchObject({ nickname: `${member.nickname}-snapshot-0`, avatarValue: 'preset-01', buyIn: '300', finalAmount: '270' });
    await read(memberCookie, `/api/history/${hidden}`).expect(404).expect(({ body }) => expect(body.code).toBe('HISTORY_SCOPE_DENIED')); await read(memberCookie, `/api/history/c${'a'.repeat(24)}`).expect(404); await read(memberCookie, '/api/history/not canonical').expect(400); await read(memberCookie, '/api/history?cursor=not-base64').expect(400); await read(memberCookie, '/api/history?limit=0').expect(400);
  }, 60_000);
});
