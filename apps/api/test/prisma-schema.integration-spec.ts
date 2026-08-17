import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../src/generated/prisma/client.js';

const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
const database = databaseUrl.pathname.slice(1);

if (!database.endsWith('_test')) {
  throw new Error(`Refusing schema integration test on database: ${database}`);
}

const prisma = new PrismaClient({
  adapter: new PrismaMariaDb({
    host: databaseUrl.hostname,
    port: Number(databaseUrl.port || 3306),
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password),
    database,
    connectionLimit: 2
  })
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Prisma financial schema', () => {
  it('creates all twelve business tables and one settings row', async () => {
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name <> '_prisma_migrations'
    `;

    expect(tables.map((row) => row.table_name).sort()).toEqual([
      'active_player_locks',
      'audit_logs',
      'auth_sessions',
      'buyin_events',
      'game_players',
      'games',
      'settlement_drafts',
      'settlement_fee_allocations',
      'settlement_results',
      'settlements',
      'system_settings',
      'users'
    ]);

    const settings = await prisma.systemSetting.findUnique({
      where: { id: 'singleton' }
    });
    expect(settings).toMatchObject({
      id: 'singleton',
      rakeThreshold: 1000n,
      rakeBps: 1000,
      version: 1
    });
    expect(await prisma.systemSetting.count()).toBe(1);
  });

  it('uses BIGINT for all eighteen money columns and no floating numeric type', async () => {
    const columns = await prisma.$queryRaw<
      Array<{ table_name: string; column_name: string; data_type: string }>
    >`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND data_type = 'bigint'
    `;
    const forbidden = await prisma.$queryRaw<
      Array<{ table_name: string; column_name: string; data_type: string }>
    >`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND data_type IN ('float', 'double', 'decimal', 'numeric')
    `;

    expect(
      columns
        .map((row) => `${row.table_name}.${row.column_name}:${row.data_type}`)
        .sort()
    ).toEqual([
      'games.hand_price:bigint',
      'settlement_fee_allocations.amount:bigint',
      'settlement_results.after_fee_profit:bigint',
      'settlement_results.buy_in:bigint',
      'settlement_results.cash_out:bigint',
      'settlement_results.final_amount:bigint',
      'settlement_results.other_fee_share:bigint',
      'settlement_results.rake_amount:bigint',
      'settlement_results.raw_profit:bigint',
      'settlement_results.room_fee_share:bigint',
      'settlements.buy_in_total:bigint',
      'settlements.cash_out_total:bigint',
      'settlements.final_total:bigint',
      'settlements.other_fee:bigint',
      'settlements.rake_threshold_used:bigint',
      'settlements.rake_total:bigint',
      'settlements.room_fee:bigint',
      'system_settings.rake_threshold:bigint'
    ]);
    expect(forbidden).toEqual([]);
  });

  it('creates every required unique and lookup index', async () => {
    const rows = await prisma.$queryRaw<
      Array<{
        table_name: string;
        index_name: string;
        non_unique: bigint;
        seq_in_index: bigint;
        column_name: string;
      }>
    >`
      SELECT table_name, index_name, non_unique, seq_in_index, column_name
      FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND index_name <> 'PRIMARY'
      ORDER BY table_name, index_name, seq_in_index
    `;
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const key = `${row.table_name}|${Number(row.non_unique)}`;
      const indexKey = `${key}|${row.index_name}`;
      const columns = grouped.get(indexKey) ?? [];
      columns[Number(row.seq_in_index) - 1] = row.column_name;
      grouped.set(indexKey, columns);
    }
    const signatures = [...grouped.entries()].map(([key, columns]) => {
      const [table, nonUnique] = key.split('|');
      return `${table}|${nonUnique}|${columns.join(',')}`;
    });

    expect(signatures).toEqual(
      expect.arrayContaining([
        'users|0|normalized_username',
        'users|0|active_normalized_nickname',
        'games|1|status,started_at',
        'game_players|0|game_id,user_id',
        'game_players|0|game_id,seat_no',
        'buyin_events|0|idempotency_key',
        'buyin_events|1|game_player_id,created_at,id',
        'settlement_drafts|0|game_id',
        'settlements|0|game_id',
        'settlement_results|0|settlement_id,game_player_id',
        'settlement_fee_allocations|0|settlement_id,fee_type,game_player_id',
        'audit_logs|1|actor_user_id,created_at',
        'audit_logs|1|entity_type,entity_id,created_at'
      ])
    );
  });

  it('declares restrictive foreign keys for permanent financial history', async () => {
    const rows = await prisma.$queryRaw<
      Array<{ constraint_name: string; delete_rule: string }>
    >`
      SELECT constraint_name, delete_rule
      FROM information_schema.referential_constraints
      WHERE constraint_schema = DATABASE()
    `;
    const deleteRules = rows.map(
      (row) => `${row.constraint_name}:${row.delete_rule}`
    );

    expect(deleteRules).toEqual(
      expect.arrayContaining([
        'game_players_game_id_fkey:RESTRICT',
        'buyin_events_game_id_fkey:RESTRICT',
        'buyin_events_game_player_id_fkey:RESTRICT',
        'settlement_results_settlement_id_fkey:RESTRICT',
        'settlement_fee_allocations_settlement_id_fkey:RESTRICT'
      ])
    );
  });

  it('enforces a key unique constraint with a real insert', async () => {
    const suffix = `${Date.now()}u`;
    const firstId = `unique-${suffix}`;
    const secondId = `duplicate-${suffix}`;
    const normalizedUsername = `unique-${suffix}`;

    try {
      await prisma.user.create({
        data: {
          id: firstId,
          username: normalizedUsername,
          normalizedUsername,
          nickname: `nick-${suffix}`,
          activeNormalizedNickname: `nick-${suffix}`,
          passwordHash: 'test-only-hash',
          avatarValue: 'preset-1'
        }
      });

      await expect(
        prisma.user.create({
          data: {
            id: secondId,
            username: `other-${suffix}`,
            normalizedUsername,
            nickname: `other-${suffix}`,
            activeNormalizedNickname: `other-${suffix}`,
            passwordHash: 'test-only-hash',
            avatarValue: 'preset-1'
          }
        })
      ).rejects.toMatchObject({ code: 'P2002' });
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: [firstId, secondId] } } });
    }
  });

  it('rejects deleting a game or player that owns buyin history', async () => {
    const suffix = `${Date.now()}b`;
    const userId = `user-${suffix}`;
    const gameId = `game-${suffix}`;
    const playerId = `player-${suffix}`;
    const eventId = `event-${suffix}`;

    try {
      await prisma.user.create({
        data: {
          id: userId,
          username: userId,
          normalizedUsername: userId,
          nickname: userId,
          activeNormalizedNickname: userId,
          passwordHash: 'test-only-hash',
          avatarValue: 'preset-1'
        }
      });
      await prisma.game.create({
        data: { id: gameId, name: 'history test', handPrice: 10n, createdById: userId }
      });
      await prisma.gamePlayer.create({
        data: {
          id: playerId,
          gameId,
          userId,
          nicknameSnapshot: userId,
          avatarKindSnapshot: 'PRESET',
          avatarValueSnapshot: 'preset-1',
          seatNo: 1,
          firstBuyinAt: new Date()
        }
      });
      await prisma.buyinEvent.create({
        data: {
          id: eventId,
          gameId,
          gamePlayerId: playerId,
          actorUserId: userId,
          type: 'BUY',
          logicalBuyId: eventId,
          newHands: 10,
          handsDelta: 10,
          idempotencyKey: `idem-${suffix}`
        }
      });

      await expect(prisma.game.delete({ where: { id: gameId } })).rejects.toMatchObject({
        code: 'P2003'
      });
      await expect(
        prisma.gamePlayer.delete({ where: { id: playerId } })
      ).rejects.toMatchObject({ code: 'P2003' });
      expect(await prisma.buyinEvent.count({ where: { id: eventId } })).toBe(1);
    } finally {
      await prisma.buyinEvent.deleteMany({ where: { id: eventId } });
      await prisma.gamePlayer.deleteMany({ where: { id: playerId } });
      await prisma.game.deleteMany({ where: { id: gameId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it('rejects deleting a settlement that owns immutable result rows', async () => {
    const suffix = `${Date.now()}s`;
    const userId = `user-${suffix}`;
    const gameId = `game-${suffix}`;
    const playerId = `player-${suffix}`;
    const settlementId = `settlement-${suffix}`;
    const resultId = `result-${suffix}`;
    const allocationId = `allocation-${suffix}`;

    try {
      await prisma.user.create({
        data: {
          id: userId,
          username: userId,
          normalizedUsername: userId,
          nickname: userId,
          activeNormalizedNickname: userId,
          passwordHash: 'test-only-hash',
          avatarValue: 'preset-1'
        }
      });
      await prisma.game.create({
        data: { id: gameId, name: 'settlement test', handPrice: 10n, createdById: userId }
      });
      await prisma.gamePlayer.create({
        data: {
          id: playerId,
          gameId,
          userId,
          nicknameSnapshot: userId,
          avatarKindSnapshot: 'PRESET',
          avatarValueSnapshot: 'preset-1',
          seatNo: 1,
          firstBuyinAt: new Date()
        }
      });
      await prisma.settlement.create({
        data: {
          id: settlementId,
          gameId,
          buyInTotal: 100n,
          cashOutTotal: 100n,
          roomFee: 0n,
          otherFee: 0n,
          rakeThresholdUsed: 1000n,
          rakeBpsUsed: 1000,
          settingsVersionUsed: 1,
          rakeTotal: 0n,
          finalTotal: 0n,
          settledById: userId,
          lockedAt: new Date()
        }
      });
      await prisma.settlementResult.create({
        data: {
          id: resultId,
          settlementId,
          gamePlayerId: playerId,
          buyIn: 100n,
          cashOut: 100n,
          rawProfit: 0n,
          roomFeeShare: 0n,
          otherFeeShare: 0n,
          afterFeeProfit: 0n,
          rakeEligible: false,
          rakeAmount: 0n,
          finalAmount: 0n
        }
      });
      await prisma.settlementFeeAllocation.create({
        data: {
          id: allocationId,
          settlementId,
          feeType: 'ROOM',
          gamePlayerId: playerId,
          allocationOrder: 1,
          amount: 0n,
          receivedRemainder: false
        }
      });

      await expect(
        prisma.settlement.delete({ where: { id: settlementId } })
      ).rejects.toMatchObject({ code: 'P2003' });
      expect(await prisma.settlementResult.count({ where: { id: resultId } })).toBe(1);
      expect(
        await prisma.settlementFeeAllocation.count({ where: { id: allocationId } })
      ).toBe(1);
    } finally {
      await prisma.settlementFeeAllocation.deleteMany({ where: { id: allocationId } });
      await prisma.settlementResult.deleteMany({ where: { id: resultId } });
      await prisma.settlement.deleteMany({ where: { id: settlementId } });
      await prisma.gamePlayer.deleteMany({ where: { id: playerId } });
      await prisma.game.deleteMany({ where: { id: gameId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
