import { notFound } from '../common/errors/app-error.js';
import type { Game, GameStatus, Prisma } from '../generated/prisma/client.js';

interface LockedGameRow {
  id: string;
  name: string;
  handPrice: bigint | number | string;
  rakeEnabled: boolean | bigint | number;
  status: GameStatus;
  version: number;
  createdById: string;
  startedAt: Date | string | null;
  stoppedAt: Date | string | null;
  completedAt: Date | string | null;
  settledById: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

function databaseBoolean(value: boolean | bigint | number): boolean {
  return value === true || value === 1 || value === 1n;
}

function databaseDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function nullableDatabaseDate(value: Date | string | null): Date | null {
  return value === null ? null : databaseDate(value);
}

export async function lockGameForUpdate(
  transaction: Prisma.TransactionClient,
  id: string
): Promise<Game> {
  const rows = await transaction.$queryRaw<LockedGameRow[]>`
    SELECT
      id,
      name,
      hand_price AS handPrice,
      rake_enabled AS rakeEnabled,
      status,
      version,
      created_by_id AS createdById,
      started_at AS startedAt,
      stopped_at AS stoppedAt,
      completed_at AS completedAt,
      settled_by_id AS settledById,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM games
    WHERE id = ${id}
    FOR UPDATE
  `;
  const row = rows[0];
  if (row === undefined) throw notFound('NOT_FOUND');
  return {
    id: row.id,
    name: row.name,
    handPrice: BigInt(row.handPrice),
    rakeEnabled: databaseBoolean(row.rakeEnabled),
    status: row.status,
    version: Number(row.version),
    createdById: row.createdById,
    startedAt: nullableDatabaseDate(row.startedAt),
    stoppedAt: nullableDatabaseDate(row.stoppedAt),
    completedAt: nullableDatabaseDate(row.completedAt),
    settledById: row.settledById,
    createdAt: databaseDate(row.createdAt),
    updatedAt: databaseDate(row.updatedAt)
  };
}
