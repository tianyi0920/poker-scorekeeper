import mariadb from 'mariadb';
import { assertProductionTarget } from './production-preflight.mjs';

const databaseUrl = process.env.DATABASE_URL ?? '';
if (process.env.NODE_ENV === 'production') assertProductionTarget(databaseUrl);
const url = new URL(databaseUrl);
const database = url.pathname.slice(1);

if (!/^[a-z][a-z0-9_]{2,63}$/.test(database)) {
  throw new Error('Invalid database name');
}
if (!process.argv.includes('--validate-only')) {
  const connection = await mariadb.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password)
  });

  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await connection.end();
  }
}
