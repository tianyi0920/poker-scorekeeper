import { randomUUID } from 'node:crypto';
import mariadb, { type Connection } from 'mariadb';
import {
  restoreOwnedSettings,
  type SettingSnapshot
} from '../../../tests/e2e/support/settings-ownership.js';

const target = new URL(process.env.DATABASE_URL ?? '');
if (
  target.protocol !== 'mysql:'
  || target.hostname !== 'tianyi.wiki'
  || target.port !== '8306'
  || target.pathname !== '/poker_scorekeeper_test'
) {
  throw new Error('Task18 settings regression requires the exact authorized test database');
}

const runId = randomUUID().replaceAll('-', '').slice(0, 8);
const ownerId = `t18cas${runId}a`;
const otherId = `t18cas${runId}b`;

function connection(): Promise<Connection> {
  return mariadb.createConnection({
    host: target.hostname,
    port: Number(target.port),
    user: decodeURIComponent(target.username),
    password: decodeURIComponent(target.password),
    database: target.pathname.slice(1),
    connectTimeout: 10_000
  });
}

describe('Task18 system-setting fixture ownership', () => {
  let writer: Connection;
  let cleanup: Connection;

  beforeAll(async () => {
    writer = await connection();
    cleanup = await connection();
    for (const [id, suffix] of [[ownerId, 'owner'], [otherId, 'other']] as const) {
      await writer.query(
        `INSERT INTO users (
          id, username, normalized_username, nickname, active_normalized_nickname,
          password_hash, role, rake_enabled, avatar_kind, avatar_value,
          is_active, must_change_password, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'SUPER_ADMIN', TRUE, 'PRESET', 'preset-01', TRUE, FALSE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
        [id, `${id}-${suffix}`, `${id}-${suffix}`, `${id}-${suffix}`, `${id}-${suffix}`, 'task18-cas-not-for-login']
      );
    }
  }, 30_000);

  afterAll(async () => {
    await cleanup?.rollback().catch(() => undefined);
    await writer?.rollback().catch(() => undefined);
    if (writer !== undefined) {
      const current = await writer.query(
        'SELECT updated_by_id FROM system_settings WHERE id = ?', ['singleton']
      ) as Array<{ updated_by_id: string | null }>;
      if (current[0]?.updated_by_id === ownerId || current[0]?.updated_by_id === otherId) {
        throw new Error('Refusing to delete Task18 CAS users while settings still reference them');
      }
      await writer.query('DELETE FROM audit_logs WHERE actor_user_id IN (?, ?)', [ownerId, otherId]);
      await writer.query('DELETE FROM users WHERE id IN (?, ?)', [ownerId, otherId]);
    }
    await cleanup?.end();
    await writer?.end();
  }, 30_000);

  it('does not overwrite another process that wins while cleanup waits for the settings row', async () => {
    // Break caught: global teardown restores an old snapshot after another process updates live settings.
    const snapshots = await writer.query(
      'SELECT rake_threshold, rake_bps, version, updated_by_id FROM system_settings WHERE id = ?',
      ['singleton']
    ) as SettingSnapshot[];
    const snapshot = snapshots[0];
    if (!snapshot) throw new Error('Missing system_settings singleton');
    const ownerVersion = snapshot.version + 1;
    const otherVersion = snapshot.version + 2;
    const ownerThreshold = snapshot.rake_threshold + 101n;
    const otherThreshold = snapshot.rake_threshold + 202n;
    const ownerUpdate = await writer.query(
      `UPDATE system_settings
          SET rake_threshold = ?, rake_bps = ?, version = ?, updated_by_id = ?
        WHERE id = ? AND version = ? AND updated_by_id <=> ?`,
      [ownerThreshold, 1101, ownerVersion, ownerId, 'singleton', snapshot.version, snapshot.updated_by_id]
    ) as { affectedRows: number };
    expect(ownerUpdate.affectedRows).toBe(1);

    let otherCommitted = false;
    let failure: unknown;
    let pendingRestore: Promise<
      { value: Awaited<ReturnType<typeof restoreOwnedSettings>> } | { error: unknown }
    > | undefined;
    try {
      await writer.beginTransaction();
      await writer.query('SELECT id FROM system_settings WHERE id = ? FOR UPDATE', ['singleton']);
      await writer.query(
        `UPDATE system_settings
            SET rake_threshold = ?, rake_bps = ?, version = ?, updated_by_id = ?
          WHERE id = ? AND version = ? AND updated_by_id = ?`,
        [otherThreshold, 1202, otherVersion, otherId, 'singleton', ownerVersion, ownerId]
      );

      await cleanup.beginTransaction();
      pendingRestore = restoreOwnedSettings(cleanup, snapshot, ownerId).then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
      await writer.commit();
      otherCommitted = true;

      const restoreResult = await pendingRestore;
      if ('error' in restoreResult) throw restoreResult.error;
      expect(restoreResult.value).toBe('skipped-not-owned');
      await cleanup.commit();

      const current = await writer.query(
        'SELECT rake_threshold, rake_bps, version, updated_by_id FROM system_settings WHERE id = ?',
        ['singleton']
      ) as SettingSnapshot[];
      expect(current[0]).toMatchObject({
        rake_threshold: otherThreshold,
        rake_bps: 1202,
        version: otherVersion,
        updated_by_id: otherId
      });
    } catch (error) {
      failure = error;
    }
    if (!otherCommitted) await writer.rollback().catch(() => undefined);
    if (pendingRestore !== undefined) await pendingRestore;
    await cleanup.rollback().catch(() => undefined);
    const restored = await writer.query(
      `UPDATE system_settings
          SET rake_threshold = ?, rake_bps = ?, version = ?, updated_by_id = ?
        WHERE id = ? AND version = ? AND updated_by_id = ?
          AND rake_threshold = ? AND rake_bps = ?`,
      [snapshot.rake_threshold, snapshot.rake_bps, snapshot.version, snapshot.updated_by_id,
        'singleton', otherVersion, otherId, otherThreshold, 1202]
    ) as { affectedRows: number };
    if (restored.affectedRows !== 1) {
      const current = await writer.query(
        'SELECT updated_by_id FROM system_settings WHERE id = ?', ['singleton']
      ) as Array<{ updated_by_id: string | null }>;
      if (current[0]?.updated_by_id === ownerId || current[0]?.updated_by_id === otherId) {
        failure ??= new Error('Task18 CAS fixture could not restore its exact owned state');
      }
    }
    if (failure !== undefined) throw failure;
  }, 30_000);
});
