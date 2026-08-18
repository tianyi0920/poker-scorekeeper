import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SettlementDraftService } from '../src/settlements/settlement-draft.service.js';
import { SettlementFinalizationService } from '../src/settlements/settlement-finalization.service.js';
import { BuyinEventType, GameStatus, Role, type User } from '../src/generated/prisma/client.js';

const databaseName = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
if (databaseName !== 'poker_scorekeeper_test') throw new Error('exact test database required');
const prefix = `settlement-concurrency-${randomUUID().replaceAll('-', '').slice(0, 5)}`;
const normalize = (value: string) => value.trim().toLowerCase();

describe.sequential('settlement finalization concurrency', () => {
  let app: INestApplication; let prisma: PrismaService; let drafts: SettlementDraftService; let finalization: SettlementFinalizationService; let admin: User; let a: User; let b: User;
  const actor = () => ({ id: admin.id, username: admin.username, nickname: admin.nickname, role: admin.role, mustChangePassword: false });
  beforeAll(async () => {
    process.env.NODE_ENV = 'test'; process.env.CSRF_SECRET = randomUUID();
    process.env.BOOTSTRAP_ADMIN_USERNAME = `${prefix}-bootstrap`; process.env.BOOTSTRAP_ADMIN_NICKNAME = prefix; process.env.BOOTSTRAP_ADMIN_PASSWORD = `${randomUUID()}Aa1!`;
    app = await createApp(); prisma = app.get(PrismaService); drafts = app.get(SettlementDraftService); finalization = app.get(SettlementFinalizationService); await app.init();
    const seed = async (suffix: string, role: Role) => prisma.user.create({ data: { username: `${prefix}-${suffix}`, normalizedUsername: normalize(`${prefix}-${suffix}`), nickname: `${prefix}-${suffix}`, activeNormalizedNickname: normalize(`${prefix}-${suffix}`), passwordHash: 'unused', role, avatarValue: 'preset-01' } });
    admin = await seed('admin', Role.ADMIN); a = await seed('a', Role.USER); b = await seed('b', Role.USER);
  }, 30_000);
  afterAll(async () => {
    const games = await prisma.game.findMany({ where: { name: { startsWith: prefix } }, select: { id: true } }); const ids = games.map((x) => x.id);
    if (ids.length) { const players = await prisma.gamePlayer.findMany({ where: { gameId: { in: ids } }, select: { id: true } }); const pids = players.map((x) => x.id); await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: ids } }, { actorUserId: { in: [admin.id, a.id, b.id] } }] } }); await prisma.settlementFeeAllocation.deleteMany({ where: { gamePlayerId: { in: pids } } }); await prisma.settlementResult.deleteMany({ where: { gamePlayerId: { in: pids } } }); await prisma.settlement.deleteMany({ where: { gameId: { in: ids } } }); await prisma.settlementDraft.deleteMany({ where: { gameId: { in: ids } } }); await prisma.buyinEvent.deleteMany({ where: { gameId: { in: ids } } }); await prisma.activePlayerLock.deleteMany({ where: { gameId: { in: ids } } }); await prisma.gamePlayer.deleteMany({ where: { gameId: { in: ids } } }); await prisma.game.deleteMany({ where: { id: { in: ids } } }); }
    await prisma.authSession.deleteMany({ where: { userId: { in: [admin.id, a.id, b.id] } } }); await prisma.user.deleteMany({ where: { id: { in: [admin.id, a.id, b.id] } } }); await app.close();
  }, 30_000);
  it('creates exactly one settlement from two real concurrent serializable transactions', async () => {
    const game = await prisma.game.create({ data: { name: `${prefix}-race`, handPrice: 300n, status: GameStatus.SETTLING, createdById: admin.id, startedAt: new Date(Date.now() - 1000), stoppedAt: new Date() } });
    const players = await Promise.all([a, b].map((user, index) => prisma.gamePlayer.create({ data: { gameId: game.id, userId: user.id, nicknameSnapshot: user.nickname, avatarKindSnapshot: user.avatarKind, avatarValueSnapshot: user.avatarValue, seatNo: index + 1, firstBuyinAt: new Date() } })));
    for (const [index, player] of players.entries()) { await prisma.buyinEvent.create({ data: { gameId: game.id, gamePlayerId: player.id, actorUserId: index === 0 ? a.id : b.id, type: BuyinEventType.BUY, logicalBuyId: `${prefix}b${index}`, newHands: 1, handsDelta: 1, gameVersion: index + 1, idempotencyKey: `${prefix}-${index}` } }); await prisma.activePlayerLock.create({ data: { gameId: game.id, userId: index === 0 ? a.id : b.id } }); }
    await prisma.settlementDraft.create({ data: { gameId: game.id, editorUserId: admin.id, updatedById: admin.id, leaseExpiresAt: new Date(Date.now() + 60_000), payload: { cashOutByPlayerId: { [players[0]!.id]: '600', [players[1]!.id]: '0' }, roomFee: '0', roomPayerIds: [], otherFee: '0', otherFeeNote: '', otherPayerIds: [] } } });
    const preview = await drafts.get(game.id, actor()); const command = { draftVersion: preview.draftVersion, settingsVersion: preview.settingsVersion, confirmationToken: preview.confirmationToken };
    const outcomes = await Promise.allSettled([finalization.finalize(game.id, actor(), command), finalization.finalize(game.id, actor(), command)]);
    expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1); await expect(prisma.settlement.count({ where: { gameId: game.id } })).resolves.toBe(1); await expect(prisma.activePlayerLock.count({ where: { gameId: game.id } })).resolves.toBe(0);
  }, 30_000);
});
