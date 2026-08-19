import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const requireFromApi = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const mariadb = requireFromApi('mariadb');
const sharp = requireFromApi('sharp');

for (const name of ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'RESTORE_DATABASE', 'RESTORE_AVATAR_ROOT', 'TASK18_DRILL_RUN_ID']) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}
if (process.env.MYSQL_HOST !== 'mysql' || process.env.MYSQL_PORT !== '3306' || process.env.RESTORE_DATABASE !== 'poker_scorekeeper_restore_test') {
  throw new Error('Restore assertion refuses every target except mysql:3306/poker_scorekeeper_restore_test');
}
const runId = process.env.TASK18_DRILL_RUN_ID;
if (!/^[a-z0-9]{6,12}$/.test(runId)) throw new Error('Invalid Task18 drill run id');

const connection = await mariadb.createConnection({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.RESTORE_DATABASE,
  connectTimeout: 10_000
});
try {
  const rows = await connection.query(
    `SELECT g.id, g.status, gp.avatar_kind_snapshot, gp.avatar_value_snapshot,
            COUNT(DISTINCT s.id) AS settlement_count, COUNT(DISTINCT sr.id) AS result_count
       FROM games g
       JOIN game_players gp ON gp.game_id = g.id
       JOIN settlements s ON s.game_id = g.id
       JOIN settlement_results sr ON sr.settlement_id = s.id AND sr.game_player_id = gp.id
      WHERE g.name = ?
      GROUP BY g.id, g.status, gp.avatar_kind_snapshot, gp.avatar_value_snapshot`,
    [`Task18 release drill ${runId}`]
  );
  if (rows.length !== 1 || rows[0].status !== 'COMPLETED' || rows[0].avatar_kind_snapshot !== 'UPLOAD'
    || Number(rows[0].settlement_count) !== 1 || Number(rows[0].result_count) !== 1) {
    throw new Error('Restored completed history is incomplete');
  }
  const avatar = rows[0].avatar_value_snapshot;
  if (!/^[a-z0-9]{3,30}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/.test(avatar)) {
    throw new Error('Restored avatar filename is not controlled');
  }
  const avatarPath = join(process.env.RESTORE_AVATAR_ROOT, avatar);
  await access(avatarPath);
  const metadata = await sharp(avatarPath).metadata();
  if (metadata.format !== 'webp' || metadata.width !== 256 || metadata.height !== 256) {
    throw new Error('Restored avatar is not the expected WebP fixture');
  }
  process.stdout.write(process.argv.includes('--print-avatar-path') ? `${avatar}\n` : 'restored data assertion passed\n');
} finally {
  await connection.end();
}
