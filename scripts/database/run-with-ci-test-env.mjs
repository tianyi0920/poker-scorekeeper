import { spawn as spawnProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import process from 'node:process';
import { URL, pathToFileURL } from 'node:url';
import { CI_TEST_DATABASE_TARGET_REFUSED, validateCiTestEnvironment } from './ci-test-environment.mjs';

function createMariaDbConnection(databaseUrl) {
  const requireFromApi = createRequire(new URL('../../apps/api/package.json', import.meta.url));
  const mariadb = requireFromApi('mariadb');
  const target = new URL(databaseUrl);
  return mariadb.createConnection({
    host: target.hostname,
    port: Number(target.port),
    user: decodeURIComponent(target.username),
    password: decodeURIComponent(target.password),
    database: target.pathname.slice(1),
    connectTimeout: 10_000
  });
}

/**
 * Run a command with a validated, isolated CI test database target.
 * Dependencies are injectable so unit tests can avoid every network call.
 */
export async function runWithCiTestEnvironment({
  environment = process.env,
  args = process.argv.slice(2),
  spawnCommand = spawnProcess,
  connect = createMariaDbConnection
} = {}) {
  const databaseUrl = validateCiTestEnvironment(environment);

  if (args[0] === '--check-only') {
    if (args.length !== 1) throw new Error(CI_TEST_DATABASE_TARGET_REFUSED);
    const connection = await connect(databaseUrl);
    try {
      await connection.query('SELECT 1');
    } finally {
      await connection.end();
    }
    return { mode: 'check-only', code: 0, signal: null };
  }

  const [command, ...commandArguments] = args;
  if (!command) throw new Error('A command is required after the guarded CI test environment');

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawnCommand(command, commandArguments, {
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
      env: { ...environment, DATABASE_URL: databaseUrl }
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('exit', (code, signal) => {
      finish({ mode: 'command', code: code ?? null, signal: signal ?? null });
    });
  });
}

export async function main() {
  try {
    const result = await runWithCiTestEnvironment();
    if (result.signal) {
      process.kill(process.pid, result.signal);
      return;
    }
    process.exitCode = result.code ?? 1;
  } catch (error) {
    const message = error instanceof Error && error.message === CI_TEST_DATABASE_TARGET_REFUSED
      ? CI_TEST_DATABASE_TARGET_REFUSED
      : error instanceof Error
        ? error.message
        : 'Guarded CI test command failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) await main();
