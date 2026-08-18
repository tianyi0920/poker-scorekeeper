import mariadb from 'mariadb';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
const database = databaseUrl.pathname.slice(1);

if (database !== 'poker_scorekeeper_test') {
  throw new Error(`Refusing settlement migration test on database: ${database}`);
}

describe('settler snapshot migration', () => {
  it('fails closed instead of synthesizing a snapshot from mutable user data', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const usersTable = `migration_users_${suffix}`;
    const settlementsTable = `migration_settlements_${suffix}`;
    const connection = await mariadb.createConnection({
      host: databaseUrl.hostname,
      port: Number(databaseUrl.port || 3306),
      user: decodeURIComponent(databaseUrl.username),
      password: decodeURIComponent(databaseUrl.password),
      database
    });

    try {
      await connection.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',STRICT_ALL_TABLES')");
      await connection.query(
        `CREATE TABLE \`${usersTable}\` (id VARCHAR(32) PRIMARY KEY, nickname VARCHAR(64) NOT NULL)`
      );
      await connection.query(
        `CREATE TABLE \`${settlementsTable}\` (` +
        '`id` VARCHAR(32) PRIMARY KEY, `settled_by_id` VARCHAR(32) NOT NULL)'
      );
      await connection.query(
        `INSERT INTO \`${usersTable}\` (id, nickname) VALUES ('user-1', 'mutable nickname')`
      );
      await connection.query(
        `INSERT INTO \`${settlementsTable}\` (id, settled_by_id) VALUES ('settlement-1', 'user-1')`
      );

      const migrationPath = fileURLToPath(new URL(
        '../prisma/migrations/20260818000100_settlement_settler_snapshot/migration.sql',
        import.meta.url
      ));
      const migration = (await readFile(migrationPath, 'utf8'))
        .replaceAll('`settlements`', `\`${settlementsTable}\``)
        .replaceAll('`users`', `\`${usersTable}\``);
      let migrationError: unknown;
      try {
        for (const statement of migration.split(';').map((sql) => sql.trim()).filter(Boolean)) {
          await connection.query(statement);
        }
      } catch (error) {
        migrationError = error;
      }

      expect(migrationError).toBeDefined();
      const rows = await connection.query<Array<{ snapshot: string | null }>>(
        `SELECT settled_by_nickname_snapshot AS snapshot FROM \`${settlementsTable}\``
      );
      expect(rows[0]?.snapshot).toBeNull();
    } finally {
      await connection.query(`DROP TABLE IF EXISTS \`${settlementsTable}\``);
      await connection.query(`DROP TABLE IF EXISTS \`${usersTable}\``);
      await connection.end();
    }
  });
});
