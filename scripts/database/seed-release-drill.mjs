import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const requireFromApi = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const mariadb = requireFromApi('mariadb');
const sharp = requireFromApi('sharp');
const argon2 = requireFromApi('argon2');

const required = ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE', 'AVATAR_ROOT', 'TASK18_DRILL_RUN_ID'];
for (const name of required) if (!process.env[name]) throw new Error(`${name} is required`);
if (process.env.MYSQL_HOST !== 'mysql' || process.env.MYSQL_PORT !== '3306' || process.env.MYSQL_DATABASE !== 'poker_scorekeeper_test') {
  throw new Error('Release drill seed refuses every database except the isolated Compose test database');
}
const runId = process.env.TASK18_DRILL_RUN_ID;
if (!/^[a-z0-9]{6,12}$/.test(runId)) throw new Error('Invalid Task18 drill run id');

const adminId = `t18adm${runId}`;
const userId = `t18usr${runId}`;
const gameId = `t18gam${runId}`;
const adminPlayerId = `t18pla${runId}`;
const userPlayerId = `t18plu${runId}`;
const settlementId = `t18set${runId}`;
const adminResultId = `t18rea${runId}`;
const userResultId = `t18reu${runId}`;
const gameName = `Task18 release drill ${runId}`;
const avatarName = `${userId}-${randomUUID()}.webp`;
const avatarPath = join(process.env.AVATAR_ROOT, avatarName);

await mkdir(process.env.AVATAR_ROOT, { recursive: true });
await writeFile(avatarPath, await sharp({
  create: { width: 256, height: 256, channels: 4, background: '#2563eb' }
}).webp().toBuffer(), { flag: 'wx' });

const connection = await mariadb.createConnection({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  connectTimeout: 10_000
});
try {
  await connection.beginTransaction();
  const passwordHash = await argon2.hash('Task18-release-drill-password-12345', { type: argon2.argon2id });
  await connection.query(
    'INSERT INTO users (id, username, normalized_username, nickname, active_normalized_nickname, password_hash, role, rake_enabled, avatar_kind, avatar_value, is_active, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))',
    [adminId, `${runId}-admin`, `${runId}-admin`, `Drill admin ${runId}`, `drill admin ${runId}`, passwordHash, 'ADMIN', 1, 'PRESET', 'preset-01', 1, 0,
      userId, `${runId}-player`, `${runId}-player`, `Drill player ${runId}`, `drill player ${runId}`, passwordHash, 'USER', 1, 'UPLOAD', avatarName, 1, 0]
  );
  await connection.query(
    "INSERT INTO games (id, name, hand_price, rake_enabled, status, version, created_by_id, started_at, stopped_at, completed_at, settled_by_id, created_at, updated_at) VALUES (?, ?, 300, 1, 'COMPLETED', 4, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [gameId, gameName, adminId, adminId]
  );
  await connection.query(
    "INSERT INTO game_players (id, game_id, user_id, nickname_snapshot, avatar_kind_snapshot, avatar_value_snapshot, seat_no, first_buyin_at, created_at) VALUES (?, ?, ?, ?, 'PRESET', 'preset-01', 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)), (?, ?, ?, ?, 'UPLOAD', ?, 2, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [adminPlayerId, gameId, adminId, `Drill admin ${runId}`, userPlayerId, gameId, userId, `Drill player ${runId}`, avatarName]
  );
  await connection.query(
    'INSERT INTO settlements (id, game_id, buy_in_total, cash_out_total, room_fee, other_fee, other_fee_note, rake_threshold_used, rake_bps_used, settings_version_used, rake_total, final_total, settled_by_id, settled_by_nickname_snapshot, locked_at, created_at) VALUES (?, ?, 900, 900, 20, 0, ?, 1000, 1000, 1, 0, -20, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))',
    [settlementId, gameId, '', adminId, `Drill admin ${runId}`]
  );
  await connection.query(
    'INSERT INTO settlement_results (id, settlement_id, game_player_id, buy_in, cash_out, raw_profit, room_fee_share, other_fee_share, after_fee_profit, rake_eligible, rake_amount, final_amount, created_at) VALUES (?, ?, ?, 600, 900, 300, 20, 0, 280, 0, 0, 280, CURRENT_TIMESTAMP(3)), (?, ?, ?, 300, 0, -300, 0, 0, -300, 0, 0, -300, CURRENT_TIMESTAMP(3))',
    [adminResultId, settlementId, adminPlayerId, userResultId, settlementId, userPlayerId]
  );
  await connection.commit();
  process.stdout.write('release drill fixture created\n');
} catch (error) {
  await connection.rollback();
  await rm(avatarPath, { force: true });
  throw error;
} finally {
  await connection.end();
}
