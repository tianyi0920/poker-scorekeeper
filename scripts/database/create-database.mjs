import mariadb from 'mariadb';

const url = new URL(process.env.DATABASE_URL);
const database = url.pathname.slice(1);

if (!/^[a-z][a-z0-9_]{2,63}$/.test(database)) {
  throw new Error('Invalid database name');
}
if (!database.endsWith('_test')) {
  throw new Error(`Refusing test database creation on database: ${database}`);
}

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
