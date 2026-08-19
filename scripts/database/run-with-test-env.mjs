import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const requireFromApi = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { parse } = requireFromApi('dotenv');
const mariadb = requireFromApi('mariadb');

const values = parse(await readFile(new URL('../../.env.local', import.meta.url), 'utf8'));
if (!values.DATABASE_URL) throw new Error('DATABASE_URL is missing from ignored .env.local');
const target = new URL(values.DATABASE_URL);
if (
  target.protocol !== 'mysql:'
  || target.hostname !== 'tianyi.wiki'
  || target.port !== '8306'
  || target.pathname !== '/poker_scorekeeper_test'
) {
  throw new Error('Release verification refuses every database except the exact authorized test target');
}

if (process.argv[2] === '--check-only') {
  const connection = await mariadb.createConnection({
    host: target.hostname,
    port: Number(target.port),
    user: decodeURIComponent(target.username),
    password: decodeURIComponent(target.password),
    database: target.pathname.slice(1),
    connectTimeout: 10_000
  });
  try {
    await connection.query('SELECT 1');
  } finally {
    await connection.end();
  }
  process.stdout.write('authorized test database guard passed\n');
  process.exit(0);
}

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('A command is required after the guarded test environment');
const child = spawn(command, args, {
  stdio: 'inherit',
  shell: false,
  windowsHide: true,
  env: { ...process.env, ...values }
});
child.on('error', (error) => {
  process.stderr.write(`Unable to start guarded command: ${error.message}\n`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`Guarded command terminated by ${signal}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
