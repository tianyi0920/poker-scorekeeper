import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface SettingSnapshot {
  rake_threshold: bigint;
  rake_bps: number;
  version: number;
  updated_by_id: string | null;
}

export interface SettingsOwnershipToken {
  predecessor: SettingSnapshot;
  owned: SettingSnapshot;
  ownerId: string;
}

interface SettingsConnection {
  query(sql: string, values?: unknown[]): Promise<unknown>;
}

export type SettingsRestoreResult = 'restored' | 'skipped-not-owned';

function tokenPath(): string {
  const runId = process.env.TASK18_RUN_ID;
  if (!runId || !/^t18[a-z0-9]+$/.test(runId)) throw new Error('Invalid Task18 run id for settings ownership');
  return resolve('test-results/task18-runtime', `settings-${runId}.json`);
}

function serializeSnapshot(value: SettingSnapshot) {
  return {
    rakeThreshold: value.rake_threshold.toString(),
    rakeBps: value.rake_bps,
    version: value.version,
    updatedById: value.updated_by_id
  };
}

function deserializeSnapshot(value: unknown): SettingSnapshot {
  const candidate = value as Record<string, unknown>;
  if (
    !/^(0|[1-9]\d*)$/.test(String(candidate?.rakeThreshold))
    || !Number.isInteger(candidate?.rakeBps)
    || !Number.isInteger(candidate?.version)
    || (candidate?.updatedById !== null && typeof candidate?.updatedById !== 'string')
  ) throw new Error('Invalid Task18 settings ownership snapshot');
  return {
    rake_threshold: BigInt(String(candidate.rakeThreshold)),
    rake_bps: candidate.rakeBps as number,
    version: candidate.version as number,
    updated_by_id: candidate.updatedById as string | null
  };
}

async function persistOwnershipToken(token: SettingsOwnershipToken): Promise<void> {
  const path = tokenPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    ownerId: token.ownerId,
    predecessor: serializeSnapshot(token.predecessor),
    owned: serializeSnapshot(token.owned)
  }), { encoding: 'utf8', flag: 'wx' });
}

export async function readSettingsOwnershipToken(): Promise<SettingsOwnershipToken | undefined> {
  let source: string;
  try {
    source = await readFile(tokenPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = JSON.parse(source) as Record<string, unknown>;
  if (typeof parsed.ownerId !== 'string') throw new Error('Invalid Task18 settings ownership token');
  return {
    ownerId: parsed.ownerId,
    predecessor: deserializeSnapshot(parsed.predecessor),
    owned: deserializeSnapshot(parsed.owned)
  };
}

export async function removeSettingsOwnershipToken(): Promise<void> {
  await unlink(tokenPath()).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export async function performOwnedSettingsUpdate<T>(
  connection: SettingsConnection,
  ownerId: string,
  desired: (predecessor: SettingSnapshot) => { threshold: string; bps: number },
  update: (input: { threshold: string; bps: number; version: number }) => Promise<T>
): Promise<T> {
  await connection.query('START TRANSACTION');
  let committed = false;
  try {
    const rows = await connection.query(
      'SELECT rake_threshold, rake_bps, version, updated_by_id FROM system_settings WHERE id = ? FOR UPDATE',
      ['singleton']
    ) as SettingSnapshot[];
    const predecessor = rows[0];
    if (!predecessor) throw new Error('Task18 requires the migrated system_settings singleton');
    const next = desired(predecessor);
    const owned: SettingSnapshot = {
      rake_threshold: BigInt(next.threshold),
      rake_bps: next.bps,
      version: predecessor.version + 1,
      updated_by_id: ownerId
    };
    await persistOwnershipToken({ predecessor, owned, ownerId });
    const pending = update({ ...next, version: predecessor.version });
    await connection.query('COMMIT');
    committed = true;
    return await pending;
  } finally {
    if (!committed) await connection.query('ROLLBACK').catch(() => undefined);
  }
}

export async function restoreOwnedSettings(
  connection: SettingsConnection,
  token: SettingsOwnershipToken
): Promise<SettingsRestoreResult> {
  const rows = await connection.query(
    'SELECT rake_threshold, rake_bps, version, updated_by_id FROM system_settings WHERE id = ? FOR UPDATE',
    ['singleton']
  ) as SettingSnapshot[];
  const current = rows[0];
  if (!current) throw new Error('Task18 requires the migrated system_settings singleton');
  if (current.updated_by_id !== token.ownerId) return 'skipped-not-owned';
  if (
    current.rake_threshold !== token.owned.rake_threshold
    || current.rake_bps !== token.owned.rake_bps
    || current.version !== token.owned.version
    || current.updated_by_id !== token.owned.updated_by_id
  ) throw new Error('Task18 settings row no longer matches its exact ownership token');

  const result = await connection.query(
    `UPDATE system_settings
        SET rake_threshold = ?, rake_bps = ?, version = ?, updated_by_id = ?
      WHERE id = ? AND rake_threshold = ? AND rake_bps = ?
        AND version = ? AND updated_by_id = ?`,
    [
      token.predecessor.rake_threshold,
      token.predecessor.rake_bps,
      token.predecessor.version,
      token.predecessor.updated_by_id,
      'singleton',
      token.owned.rake_threshold,
      token.owned.rake_bps,
      token.owned.version,
      token.ownerId
    ]
  ) as { affectedRows: number };
  if (result.affectedRows !== 1) {
    throw new Error('Task18 settings ownership changed during compare-and-swap restore');
  }
  return 'restored';
}
