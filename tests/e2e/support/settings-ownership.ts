export interface SettingSnapshot {
  rake_threshold: bigint;
  rake_bps: number;
  version: number;
  updated_by_id: string | null;
}

interface SettingsConnection {
  query(sql: string, values?: unknown[]): Promise<unknown>;
}

export type SettingsRestoreResult = 'restored' | 'skipped-not-owned';

export async function restoreOwnedSettings(
  connection: SettingsConnection,
  snapshot: SettingSnapshot,
  ownerId: string
): Promise<SettingsRestoreResult> {
  const rows = await connection.query(
    'SELECT rake_threshold, rake_bps, version, updated_by_id FROM system_settings WHERE id = ? FOR UPDATE',
    ['singleton']
  ) as SettingSnapshot[];
  const current = rows[0];
  if (!current) throw new Error('Task18 requires the migrated system_settings singleton');
  if (current.updated_by_id !== ownerId) return 'skipped-not-owned';

  const result = await connection.query(
    `UPDATE system_settings
        SET rake_threshold = ?, rake_bps = ?, version = ?, updated_by_id = ?
      WHERE id = ? AND version = ? AND updated_by_id = ?`,
    [
      snapshot.rake_threshold,
      snapshot.rake_bps,
      snapshot.version,
      snapshot.updated_by_id,
      'singleton',
      current.version,
      ownerId
    ]
  ) as { affectedRows: number };
  if (result.affectedRows !== 1) {
    throw new Error('Task18 settings ownership changed during compare-and-swap restore');
  }
  return 'restored';
}
