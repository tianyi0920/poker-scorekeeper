/* global URL, process */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const requireFromApi = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const mariadb = requireFromApi('mariadb');
const TARGET_DATABASE = 'poker_scorekeeper';
const CONFIGURATION_KEYS_WITH_PLACEHOLDERS = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'CSRF_SECRET',
  'BOOTSTRAP_ADMIN_NICKNAME',
  'BOOTSTRAP_ADMIN_PASSWORD',
  'MYSQL_PASSWORD'
];

function controlledError(code) {
  return new Error(code);
}

export function assertProductionEnvironment(environment) {
  for (const key of CONFIGURATION_KEYS_WITH_PLACEHOLDERS) {
    const value = environment[key];
    if (typeof value === 'string' && value.toUpperCase().includes('CHANGE_ME')) {
      throw controlledError('PRODUCTION_CONFIGURATION_PLACEHOLDER');
    }
  }
  if (environment.PUBLIC_ORIGIN === 'https://poker.example.com') {
    throw controlledError('PRODUCTION_CONFIGURATION_PLACEHOLDER');
  }
}

export function assertProductionTarget(databaseUrl) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw controlledError('PRODUCTION_DATABASE_URL_INVALID');
  }

  if (url.protocol !== 'mysql:') {
    throw controlledError('PRODUCTION_DATABASE_URL_INVALID');
  }
  if (url.hostname !== '192.168.10.248' || Number(url.port) !== 3306) {
    throw controlledError('PRODUCTION_DATABASE_HOST_INVALID');
  }
  if (url.pathname.slice(1) !== TARGET_DATABASE) {
    throw controlledError('PRODUCTION_DATABASE_NAME_INVALID');
  }
  if (url.username === '' || url.password === '') {
    throw controlledError('PRODUCTION_DATABASE_CREDENTIALS_MISSING');
  }
  return url;
}

function firstRow(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== 'object' || rows[0] === null) {
    throw controlledError('PRODUCTION_PREFLIGHT_RESPONSE_INVALID');
  }
  return rows[0];
}

function countFrom(rows, key) {
  const count = Number(firstRow(rows)[key]);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw controlledError('PRODUCTION_PREFLIGHT_RESPONSE_INVALID');
  }
  return count;
}

function grantsFrom(rows) {
  if (!Array.isArray(rows)) throw controlledError('PRODUCTION_PREFLIGHT_RESPONSE_INVALID');
  return rows.map((row) => {
    if (typeof row !== 'object' || row === null) {
      throw controlledError('PRODUCTION_PREFLIGHT_RESPONSE_INVALID');
    }
    const grant = Object.values(row)[0];
    if (typeof grant !== 'string') {
      throw controlledError('PRODUCTION_PREFLIGHT_RESPONSE_INVALID');
    }
    return grant;
  });
}

function grantAllowsTargetCreation(grant) {
  const match = /^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i.exec(grant);
  if (match === null) return false;
  const privileges = match[1].split(',').map((privilege) => privilege.trim().toUpperCase());
  const scope = match[2].replaceAll('`', '').toLowerCase();
  const createGranted = privileges.includes('CREATE') || privileges.includes('ALL PRIVILEGES');
  return createGranted && (scope === '*.*' || scope === `${TARGET_DATABASE}.*`);
}

function safeServerVersion(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._+~-]{1,128}$/.test(value)) {
    throw controlledError('PRODUCTION_PREFLIGHT_RESPONSE_INVALID');
  }
  return value;
}

function isControlledError(error) {
  return error instanceof Error && /^PRODUCTION_[A-Z0-9_]+$/.test(error.message);
}

export async function runProductionPreflight(
  databaseUrl,
  connect = (options) => mariadb.createConnection(options)
) {
  const url = assertProductionTarget(databaseUrl);
  let connection;
  let primaryError;
  let closeError;
  let report;
  try {
    connection = await connect({
      host: url.hostname,
      port: Number(url.port),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      connectTimeout: 5_000,
      socketTimeout: 5_000
    });

    const databaseExists = countFrom(await connection.query(
      "SELECT COUNT(*) AS databaseCount FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'poker_scorekeeper'"
    ), 'databaseCount') === 1;
    const utf8mb4Available = countFrom(await connection.query(
      "SELECT COUNT(*) AS utf8mb4Count FROM information_schema.CHARACTER_SETS WHERE CHARACTER_SET_NAME = 'utf8mb4'"
    ), 'utf8mb4Count') === 1;
    if (!utf8mb4Available) throw controlledError('PRODUCTION_UTF8MB4_UNAVAILABLE');

    const grants = grantsFrom(await connection.query('SHOW GRANTS FOR CURRENT_USER'));
    const canCreateDatabase = grants.some(grantAllowsTargetCreation);
    let canUseDatabase = false;
    if (databaseExists) {
      try {
        await connection.query('USE `poker_scorekeeper`');
        canUseDatabase = true;
      } catch {
        throw controlledError('PRODUCTION_DATABASE_USE_DENIED');
      }
    } else if (!canCreateDatabase) {
      throw controlledError('PRODUCTION_DATABASE_CREATE_DENIED');
    }

    const versionRows = await connection.query(
      'SELECT VERSION() AS serverVersion, DATABASE() AS currentDatabase'
    );
    const versionRow = firstRow(versionRows);
    const currentDatabase = versionRow.currentDatabase;
    if (currentDatabase !== null && currentDatabase !== TARGET_DATABASE) {
      throw controlledError('PRODUCTION_PREFLIGHT_RESPONSE_INVALID');
    }

    report = {
      serverVersion: safeServerVersion(versionRow.serverVersion),
      currentDatabase,
      utf8mb4Available,
      databaseExists,
      canCreateDatabase,
      canUseDatabase
    };
  } catch (error) {
    primaryError = isControlledError(error)
      ? error
      : controlledError('PRODUCTION_PREFLIGHT_FAILED');
  } finally {
    if (connection !== undefined) {
      try {
        await connection.end();
      } catch {
        if (primaryError === undefined) {
          closeError = controlledError('PRODUCTION_PREFLIGHT_CLOSE_FAILED');
        }
      }
    }
  }

  if (primaryError !== undefined) throw primaryError;
  if (closeError !== undefined) throw closeError;
  if (report === undefined) throw controlledError('PRODUCTION_PREFLIGHT_FAILED');
  return report;
}

function publicErrorCode(error) {
  return isControlledError(error) ? error.message : 'PRODUCTION_PREFLIGHT_FAILED';
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    assertProductionEnvironment(process.env);
    const report = await runProductionPreflight(process.env.DATABASE_URL ?? '');
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(`${publicErrorCode(error)}\n`);
    process.exitCode = 1;
  }
}
