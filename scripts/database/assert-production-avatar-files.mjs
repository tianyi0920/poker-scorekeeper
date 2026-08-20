/* global URL, process */

import { lstat as lstatFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";
import { assertProductionTarget } from "./production-preflight.mjs";

const requireFromApi = createRequire(
  new URL("../../apps/api/package.json", import.meta.url),
);
const mariadb = requireFromApi("mariadb");
const PRODUCTION_AVATAR_ROOT = "/data/avatars";
const UPLOAD_FILENAME =
  /^[a-z0-9]{3,30}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/;

function controlledError(code) {
  return new Error(code);
}

function isControlledError(error) {
  return (
    error instanceof Error &&
    /^PRODUCTION_(?:DATABASE|AVATAR)_[A-Z0-9_]+$/.test(error.message)
  );
}

function tableNamesFrom(rows) {
  if (!Array.isArray(rows))
    throw controlledError("PRODUCTION_AVATAR_DATABASE_RESPONSE_INVALID");
  const names = new Set();
  for (const row of rows) {
    if (
      typeof row !== "object" ||
      row === null ||
      typeof row.tableName !== "string"
    ) {
      throw controlledError("PRODUCTION_AVATAR_DATABASE_RESPONSE_INVALID");
    }
    names.add(row.tableName);
  }
  if (names.size === 0) return names;
  if (names.size !== 2 || !names.has("users") || !names.has("game_players")) {
    throw controlledError("PRODUCTION_AVATAR_SCHEMA_INCOMPLETE");
  }
  return names;
}

function uploadValuesFrom(rows) {
  if (!Array.isArray(rows))
    throw controlledError("PRODUCTION_AVATAR_DATABASE_RESPONSE_INVALID");
  const values = new Set();
  for (const row of rows) {
    if (
      typeof row !== "object" ||
      row === null ||
      typeof row.avatarValue !== "string"
    ) {
      throw controlledError("PRODUCTION_AVATAR_DATABASE_RESPONSE_INVALID");
    }
    if (!UPLOAD_FILENAME.test(row.avatarValue)) {
      throw controlledError("PRODUCTION_AVATAR_REFERENCE_UNSAFE");
    }
    values.add(row.avatarValue);
  }
  return [...values].sort();
}

export async function verifyProductionAvatarFiles(
  environment,
  dependencies = {},
) {
  const url = assertProductionTarget(environment.DATABASE_URL ?? "");
  if (environment.AVATAR_ROOT !== PRODUCTION_AVATAR_ROOT) {
    throw controlledError("PRODUCTION_AVATAR_ROOT_INVALID");
  }

  const connect =
    dependencies.connect ?? ((options) => mariadb.createConnection(options));
  const lstat = dependencies.lstat ?? lstatFile;
  let connection;
  let primaryError;
  let closeError;
  let report;
  try {
    let rootStats;
    try {
      rootStats = await lstat(PRODUCTION_AVATAR_ROOT);
    } catch {
      throw controlledError("PRODUCTION_AVATAR_ROOT_INVALID");
    }
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw controlledError("PRODUCTION_AVATAR_ROOT_INVALID");
    }

    connection = await connect({
      host: url.hostname,
      port: Number(url.port),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      connectTimeout: 5_000,
      socketTimeout: 5_000,
    });
    const tables = tableNamesFrom(
      await connection.query(
        "SELECT TABLE_NAME AS tableName FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'poker_scorekeeper' AND TABLE_NAME IN ('users', 'game_players') ORDER BY TABLE_NAME",
      ),
    );
    const avatarValues =
      tables.size === 0
        ? []
        : uploadValuesFrom(
            await connection.query(
              "SELECT avatar_value AS avatarValue FROM poker_scorekeeper.users WHERE avatar_kind = 'UPLOAD' UNION SELECT avatar_value_snapshot AS avatarValue FROM poker_scorekeeper.game_players WHERE avatar_kind_snapshot = 'UPLOAD' ORDER BY avatarValue",
            ),
          );

    for (const avatarValue of avatarValues) {
      let stats;
      try {
        stats = await lstat(posix.join(PRODUCTION_AVATAR_ROOT, avatarValue));
      } catch {
        throw controlledError("PRODUCTION_AVATAR_FILE_MISSING");
      }
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw controlledError("PRODUCTION_AVATAR_FILE_UNSAFE");
      }
    }
    report = { uploadFileCount: avatarValues.length };
  } catch (error) {
    primaryError = isControlledError(error)
      ? error
      : controlledError("PRODUCTION_AVATAR_VERIFICATION_FAILED");
  } finally {
    if (connection !== undefined) {
      try {
        await connection.end();
      } catch {
        if (primaryError === undefined) {
          closeError = controlledError("PRODUCTION_AVATAR_CLOSE_FAILED");
        }
      }
    }
  }

  if (primaryError !== undefined) throw primaryError;
  if (closeError !== undefined) throw closeError;
  if (report === undefined)
    throw controlledError("PRODUCTION_AVATAR_VERIFICATION_FAILED");
  return report;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const report = await verifyProductionAvatarFiles(process.env);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    const code = isControlledError(error)
      ? error.message
      : "PRODUCTION_AVATAR_VERIFICATION_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
