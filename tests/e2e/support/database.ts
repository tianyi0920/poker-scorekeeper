import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
// @ts-expect-error The CI guard is intentionally a small, plain ESM boundary.
import { validateCiTestEnvironment } from '../../../scripts/database/ci-test-environment.mjs';

const requireFromApi = createRequire(resolve('apps/api/package.json'));
const { parse } = requireFromApi('dotenv') as { parse(source: string): Record<string, string> };
const mariadb = requireFromApi('mariadb') as {
  createConnection(options: Record<string, unknown>): Promise<any>;
};

export interface TestDatabaseEnvironment {
  values: Record<string, string>;
  url: URL;
}

export async function readTestDatabaseEnvironment(): Promise<TestDatabaseEnvironment> {
  if (process.env.GITHUB_ACTIONS !== undefined) {
    const databaseUrl = validateCiTestEnvironment(process.env) as string;
    process.env.DATABASE_URL = databaseUrl;
    return { values: { DATABASE_URL: databaseUrl }, url: new URL(databaseUrl) };
  }

  const values = parse(await readFile('.env.local', 'utf8'));
  if (!values.DATABASE_URL) throw new Error('DATABASE_URL is missing from ignored .env.local');
  const url = new URL(values.DATABASE_URL);
  if (
    url.protocol !== 'mysql:'
    || url.hostname !== 'tianyi.wiki'
    || url.port !== '8306'
    || url.pathname !== '/poker_scorekeeper_test'
  ) {
    throw new Error('Task18 refuses every database except mysql://tianyi.wiki:8306/poker_scorekeeper_test');
  }
  // The validated file is authoritative even when the Playwright parent was
  // launched from a shell carrying an unrelated DATABASE_URL.
  process.env.DATABASE_URL = values.DATABASE_URL;
  return { values, url };
}

export async function openTestDatabase() {
  const { url } = await readTestDatabaseEnvironment();
  return mariadb.createConnection({
    host: url.hostname,
    port: Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    connectTimeout: 10_000
  });
}

export async function cleanupTaskGame(gameId: string): Promise<void> {
  const connection = await openTestDatabase();
  try {
    await connection.beginTransaction();
    const games = await connection.query(
      'SELECT id, name FROM games WHERE id = ? AND name LIKE ?',
      [gameId, 'Task18 %']
    ) as Array<{ id: string; name: string }>;
    if (games.length !== 1) throw new Error('Refusing cleanup of a game outside the exact Task18 fixture');
    const players = await connection.query(
      'SELECT id FROM game_players WHERE game_id = ?', [gameId]
    ) as Array<{ id: string }>;
    const settlements = await connection.query(
      'SELECT id FROM settlements WHERE game_id = ?', [gameId]
    ) as Array<{ id: string }>;
    for (const { id: settlementId } of settlements) {
      await connection.query('DELETE FROM settlement_fee_allocations WHERE settlement_id = ?', [settlementId]);
      await connection.query('DELETE FROM settlement_results WHERE settlement_id = ?', [settlementId]);
    }
    await connection.query('DELETE FROM settlements WHERE game_id = ?', [gameId]);
    await connection.query('DELETE FROM settlement_drafts WHERE game_id = ?', [gameId]);
    await connection.query('DELETE FROM buyin_events WHERE game_id = ?', [gameId]);
    await connection.query('DELETE FROM active_player_locks WHERE game_id = ?', [gameId]);
    for (const { id: playerId } of players) {
      await connection.query('DELETE FROM settlement_fee_allocations WHERE game_player_id = ?', [playerId]);
      await connection.query('DELETE FROM settlement_results WHERE game_player_id = ?', [playerId]);
    }
    await connection.query('DELETE FROM game_players WHERE game_id = ?', [gameId]);
    await connection.query('DELETE FROM audit_logs WHERE entity_type = ? AND entity_id = ?', ['GAME', gameId]);
    await connection.query('DELETE FROM games WHERE id = ?', [gameId]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

export async function expireTask18SettlementLease(gameId: string): Promise<void> {
  const connection = await openTestDatabase();
  try {
    await connection.beginTransaction();
    const games = await connection.query(
      'SELECT id FROM games WHERE id = ? AND name LIKE ?', [gameId, 'Task18 %']
    ) as unknown[];
    if (games.length !== 1) throw new Error('Refusing lease mutation outside the exact Task18 fixture');
    const result = await connection.query(
      'UPDATE settlement_drafts SET lease_expires_at = DATE_SUB(lease_expires_at, INTERVAL 1 DAY) WHERE game_id = ?',
      [gameId]
    ) as { affectedRows: number };
    if (result.affectedRows !== 1) throw new Error('Expected exactly one Task18 settlement lease');
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}
