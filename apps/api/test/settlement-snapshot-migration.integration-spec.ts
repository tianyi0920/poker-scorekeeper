import mariadb, { type Connection } from 'mariadb';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { requireAuthorizedTestDatabase } from './support/authorized-test-database.js';

const databaseUrl = requireAuthorizedTestDatabase();
const database = databaseUrl.pathname.slice(1);

const sqlModes = [
  { label: 'non-strict mode', value: '' },
  { label: 'strict mode', value: 'STRICT_ALL_TABLES' }
] as const;

async function actualMigrationSql(settlementsTable: string, guardTable: string): Promise<string> {
  const migrationPath = fileURLToPath(new URL(
    '../prisma/migrations/20260818000100_settlement_settler_snapshot/migration.sql',
    import.meta.url
  ));
  return (await readFile(migrationPath, 'utf8'))
    .replaceAll('`settlements`', `\`${settlementsTable}\``)
    .replaceAll('`_migration_guard_settler_snapshot`', `\`${guardTable}\``);
}

async function executeStatements(connection: Connection, sql: string): Promise<unknown> {
  try {
    for (const statement of sql.split(';').map((value) => value.trim()).filter(Boolean)) {
      await connection.query(statement);
    }
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('settler snapshot migration', () => {
  it.each(sqlModes)('fails before schema or data changes with old settlements in $label', async ({ value }) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const settlementsTable = `migration_settlements_${suffix}`;
    const guardTable = `migration_guard_${suffix}`;
    const connection = await mariadb.createConnection({
      host: databaseUrl.hostname,
      port: Number(databaseUrl.port || 3306),
      user: decodeURIComponent(databaseUrl.username),
      password: decodeURIComponent(databaseUrl.password),
      database
    });
    const originalMode = String((await connection.query<Array<{ sqlMode: string }>>(
      'SELECT @@SESSION.sql_mode AS sqlMode'
    ))[0]?.sqlMode ?? '');

    try {
      await connection.query('SET SESSION sql_mode = ?', [value]);
      await connection.query(
        `CREATE TABLE \`${settlementsTable}\` (` +
        '`id` VARCHAR(32) PRIMARY KEY, `settled_by_id` VARCHAR(32) NOT NULL)'
      );
      await connection.query(
        `INSERT INTO \`${settlementsTable}\` (id, settled_by_id) VALUES ('settlement-1', 'user-1')`
      );

      const migrationError = await executeStatements(
        connection,
        await actualMigrationSql(settlementsTable, guardTable)
      );

      expect(migrationError).toMatchObject({ code: 'ER_DUP_ENTRY' });
      const columns = await connection.query<Array<{ Field: string }>>(
        `SHOW COLUMNS FROM \`${settlementsTable}\``
      );
      expect(columns.map(({ Field }) => Field)).toEqual(['id', 'settled_by_id']);
      const rows = await connection.query<Array<{ id: string; settledById: string }>>(
        `SELECT id, settled_by_id AS settledById FROM \`${settlementsTable}\``
      );
      expect(rows).toMatchObject([{ id: 'settlement-1', settledById: 'user-1' }]);
    } finally {
      await connection.query('SET SESSION sql_mode = ?', [originalMode]);
      await connection.query(`DROP TEMPORARY TABLE IF EXISTS \`${guardTable}\``);
      await connection.query(`DROP TABLE IF EXISTS \`${settlementsTable}\``);
      await connection.end();
    }
  });

  it.each(sqlModes)('migrates an empty settlement table and creates a required snapshot in $label', async ({ value }) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const settlementsTable = `migration_settlements_${suffix}`;
    const guardTable = `migration_guard_${suffix}`;
    const connection = await mariadb.createConnection({
      host: databaseUrl.hostname,
      port: Number(databaseUrl.port || 3306),
      user: decodeURIComponent(databaseUrl.username),
      password: decodeURIComponent(databaseUrl.password),
      database
    });
    const originalMode = String((await connection.query<Array<{ sqlMode: string }>>(
      'SELECT @@SESSION.sql_mode AS sqlMode'
    ))[0]?.sqlMode ?? '');

    try {
      await connection.query('SET SESSION sql_mode = ?', [value]);
      await connection.query(
        `CREATE TABLE \`${settlementsTable}\` (` +
        '`id` VARCHAR(32) PRIMARY KEY, `settled_by_id` VARCHAR(32) NOT NULL)'
      );

      const migrationError = await executeStatements(
        connection,
        await actualMigrationSql(settlementsTable, guardTable)
      );

      expect(migrationError).toBeUndefined();
      const columns = await connection.query<Array<{ Field: string; Null: string }>>(
        `SHOW COLUMNS FROM \`${settlementsTable}\``
      );
      expect(columns).toContainEqual(expect.objectContaining({
        Field: 'settled_by_nickname_snapshot',
        Null: 'NO'
      }));
    } finally {
      await connection.query('SET SESSION sql_mode = ?', [originalMode]);
      await connection.query(`DROP TEMPORARY TABLE IF EXISTS \`${guardTable}\``);
      await connection.query(`DROP TABLE IF EXISTS \`${settlementsTable}\``);
      await connection.end();
    }
  });
});
