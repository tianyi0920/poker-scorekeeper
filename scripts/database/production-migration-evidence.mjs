/* global URL, process */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { assertProductionTarget } from './production-preflight.mjs';

const requireFromApi = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const mariadb = requireFromApi('mariadb');

function controlledError(code) {
  return new Error(code);
}

function isControlledError(error) {
  return error instanceof Error && /^PRODUCTION_[A-Z0-9_]+$/.test(error.message);
}

export async function readProductionMigrationEvidence(
  databaseUrl,
  connect = (options) => mariadb.createConnection(options)
) {
  const url = assertProductionTarget(databaseUrl);
  let connection;
  let report;
  let primaryError;
  let closeError;
  try {
    connection = await connect({
      host: url.hostname,
      port: Number(url.port),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: 'poker_scorekeeper',
      connectTimeout: 5_000,
      socketTimeout: 5_000
    });
    const rows = await connection.query(
      'SELECT migration_name, checksum, finished_at, rolled_back_at FROM `_prisma_migrations` ORDER BY migration_name ASC'
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      throw controlledError('PRODUCTION_MIGRATION_EVIDENCE_INVALID');
    }
    report = {
      migrations: rows.map((row) => {
        if (
          typeof row !== 'object' || row === null ||
          typeof row.migration_name !== 'string' ||
          !/^\d{14}_[a-z0-9_]+$/.test(row.migration_name) ||
          typeof row.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(row.checksum) ||
          row.finished_at === null || row.rolled_back_at !== null
        ) {
          throw controlledError('PRODUCTION_MIGRATION_EVIDENCE_INVALID');
        }
        return { name: row.migration_name, checksum: row.checksum };
      })
    };
  } catch (error) {
    primaryError = isControlledError(error)
      ? error
      : controlledError('PRODUCTION_MIGRATION_EVIDENCE_FAILED');
  } finally {
    if (connection !== undefined) {
      try {
        await connection.end();
      } catch {
        closeError = controlledError('PRODUCTION_MIGRATION_EVIDENCE_CLOSE_FAILED');
      }
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (closeError !== undefined) throw closeError;
  return report;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const report = await readProductionMigrationEvidence(process.env.DATABASE_URL ?? '');
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(`${isControlledError(error) ? error.message : 'PRODUCTION_MIGRATION_EVIDENCE_FAILED'}\n`);
    process.exitCode = 1;
  }
}
