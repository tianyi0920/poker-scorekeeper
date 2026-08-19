/* global process */

import { pathToFileURL } from 'node:url';
import { assertProductionTarget } from './production-preflight.mjs';

function controlledError(code) {
  return new Error(code);
}

export function assertProductionBackupTarget(environment) {
  assertProductionTarget(environment.DATABASE_URL ?? '');
  if (
    environment.MYSQL_HOST !== '192.168.10.248' ||
    environment.MYSQL_PORT !== '3306' ||
    environment.MYSQL_DATABASE !== 'poker_scorekeeper'
  ) {
    throw controlledError('PRODUCTION_BACKUP_TARGET_INVALID');
  }
  if (
    typeof environment.MYSQL_USER !== 'string' || environment.MYSQL_USER === '' ||
    typeof environment.MYSQL_PASSWORD !== 'string' || environment.MYSQL_PASSWORD === ''
  ) {
    throw controlledError('PRODUCTION_BACKUP_CREDENTIALS_MISSING');
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    assertProductionBackupTarget(process.env);
  } catch (error) {
    const code = error instanceof Error && /^PRODUCTION_[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : 'PRODUCTION_BACKUP_TARGET_INVALID';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
