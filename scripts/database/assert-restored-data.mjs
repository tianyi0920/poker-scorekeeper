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
    `SELECT g.id, g.status, s.buy_in_total, s.cash_out_total, s.room_fee,
            s.other_fee, s.rake_total, s.final_total
       FROM games g
       JOIN settlements s ON s.game_id = g.id
      WHERE g.name = ?
      `,
    [`Task18 release drill ${runId}`]
  );
  if (rows.length !== 1 || rows[0].status !== 'COMPLETED'
    || String(rows[0].buy_in_total) !== '900' || String(rows[0].cash_out_total) !== '900'
    || String(rows[0].room_fee) !== '20' || String(rows[0].other_fee) !== '0'
    || String(rows[0].rake_total) !== '0' || String(rows[0].final_total) !== '-20') {
    throw new Error('Restored completed history is incomplete');
  }
  const players = await connection.query(
    `SELECT gp.nickname_snapshot, gp.avatar_kind_snapshot, gp.avatar_value_snapshot,
            sr.buy_in, sr.cash_out, sr.raw_profit, sr.room_fee_share,
            sr.other_fee_share, sr.after_fee_profit, sr.rake_amount, sr.final_amount
       FROM game_players gp
       JOIN settlement_results sr ON sr.game_player_id = gp.id
       JOIN settlements s ON s.id = sr.settlement_id AND s.game_id = gp.game_id
      WHERE gp.game_id = ?
      ORDER BY gp.seat_no`,
    [rows[0].id]
  );
  const expectedPlayers = [
    [`Drill admin ${runId}`, 'PRESET', '600', '900', '300', '20', '0', '280', '0', '280'],
    [`Drill player ${runId}`, 'UPLOAD', '300', '0', '-300', '0', '0', '-300', '0', '-300']
  ];
  const fields = ['nickname_snapshot', 'avatar_kind_snapshot', 'buy_in', 'cash_out', 'raw_profit',
    'room_fee_share', 'other_fee_share', 'after_fee_profit', 'rake_amount', 'final_amount'];
  if (players.length !== expectedPlayers.length || !players.every((player, index) => (
    fields.every((field, fieldIndex) => String(player[field]) === expectedPlayers[index][fieldIndex])
  ))) {
    throw new Error('Restored settlement participants or amounts are incomplete');
  }
  const avatar = players[1].avatar_value_snapshot;
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
