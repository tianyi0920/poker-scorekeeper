import { randomUUID } from 'node:crypto';
import mariadb, { type Connection } from 'mariadb';
import {
  restoreOwnedSettings,
  type SettingSnapshot,
  type SettingsOwnershipToken
} from '../../../tests/e2e/support/settings-ownership.js';
import { requireAuthorizedTestDatabase } from './support/authorized-test-database.js';

const target = requireAuthorizedTestDatabase();

const runId = randomUUID().replaceAll('-', '').slice(0, 8);
const baseId = `t18cas${runId}b`;
const externalId = `t18cas${runId}e`;
const ownerId = `t18cas${runId}o`;
const fixtureIds = new Set([baseId, externalId, ownerId]);

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

async function readSettings(connection: Connection): Promise<SettingSnapshot> {
  const rows = await connection.query(
    'SELECT rake_threshold, rake_bps, version, updated_by_id FROM system_settings WHERE id = ?',
    ['singleton']
  ) as SettingSnapshot[];
  if (!rows[0]) throw new Error('Missing system_settings singleton');
  return rows[0];
}

async function updateExact(
  connection: Connection,
  before: SettingSnapshot,
  after: SettingSnapshot
): Promise<void> {
  const result = await connection.query(
    `UPDATE system_settings
        SET rake_threshold = ?, rake_bps = ?, version = ?, updated_by_id = ?
      WHERE id = ? AND rake_threshold = ? AND rake_bps = ?
        AND version = ? AND updated_by_id <=> ?`,
    [
      after.rake_threshold,
      after.rake_bps,
      after.version,
      after.updated_by_id,
      'singleton',
      before.rake_threshold,
      before.rake_bps,
      before.version,
      before.updated_by_id
    ]
  ) as { affectedRows: number };
  if (result.affectedRows !== 1) throw new Error('Task18 exact settings transition lost ownership');
}

function snapshot(
  rakeThreshold: bigint,
  rakeBps: number,
  version: number,
  updatedById: string | null
): SettingSnapshot {
  return {
    rake_threshold: rakeThreshold,
    rake_bps: rakeBps,
    version,
    updated_by_id: updatedById
  };
}

function token(predecessor: SettingSnapshot, owned: SettingSnapshot): SettingsOwnershipToken {
  return { predecessor, owned, ownerId };
}

describe.sequential('Task18 system-setting fixture ownership', () => {
  let writer: Connection;
  let cleanup: Connection;

  beforeAll(async () => {
    writer = await connection();
    cleanup = await connection();
    for (const id of fixtureIds) {
      await writer.query(
        `INSERT INTO users (
          id, username, normalized_username, nickname, active_normalized_nickname,
          password_hash, role, rake_enabled, avatar_kind, avatar_value,
          is_active, must_change_password, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'SUPER_ADMIN', TRUE, 'PRESET', 'preset-01', TRUE, FALSE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
        [id, id, id, id, id, 'task18-cas-not-for-login']
      );
    }
  }, 30_000);

  afterAll(async () => {
    await cleanup?.rollback().catch(() => undefined);
    await writer?.rollback().catch(() => undefined);
    if (writer !== undefined) {
      const current = await readSettings(writer);
      if (current.updated_by_id !== null && fixtureIds.has(current.updated_by_id)) {
        throw new Error('Refusing to delete Task18 CAS users while settings still reference them');
      }
      await writer.query('DELETE FROM audit_logs WHERE actor_user_id IN (?, ?, ?)', [baseId, externalId, ownerId]);
      await writer.query('DELETE FROM users WHERE id IN (?, ?, ?)', [baseId, externalId, ownerId]);
    }
    await cleanup?.end();
    await writer?.end();
  }, 30_000);

  async function prepareDeterministicChain(): Promise<{
    original: SettingSnapshot;
    predecessor: SettingSnapshot;
    owned: SettingSnapshot;
  }> {
    const original = await readSettings(writer);
    const version10 = snapshot(1010n, 1010, 10, baseId);
    const predecessor = snapshot(1111n, 1111, 11, externalId);
    const owned = snapshot(1212n, 1212, 12, ownerId);
    await updateExact(writer, original, version10);
    await updateExact(writer, version10, predecessor);
    await updateExact(writer, predecessor, owned);
    return { original, predecessor, owned };
  }

  async function restoreOriginal(original: SettingSnapshot): Promise<void> {
    const current = await readSettings(writer);
    if (
      current.rake_threshold === original.rake_threshold
      && current.rake_bps === original.rake_bps
      && current.version === original.version
      && current.updated_by_id === original.updated_by_id
    ) return;
    if (current.updated_by_id === null || !fixtureIds.has(current.updated_by_id)) {
      throw new Error('External settings update won; refusing Task18 scenario cleanup');
    }
    await updateExact(writer, current, original);
  }

  it('restores only the direct external v11 predecessor of the fixture-owned v12 update', async () => {
    // Break caught: teardown restores the suite-start snapshot v10 instead of the direct v11 predecessor.
    const chain = await prepareDeterministicChain();
    try {
      await cleanup.beginTransaction();
      expect(await restoreOwnedSettings(cleanup, token(chain.predecessor, chain.owned))).toBe('restored');
      await cleanup.commit();
      expect(await readSettings(writer)).toEqual(chain.predecessor);
    } finally {
      await cleanup.rollback().catch(() => undefined);
      await restoreOriginal(chain.original);
    }
  }, 30_000);

  it('does not overwrite an external v13 update that wins after fixture-owned v12', async () => {
    // Break caught: teardown recognizes only updated_by_id and overwrites a newer external version.
    const chain = await prepareDeterministicChain();
    const externalWinner = snapshot(1313n, 1313, 13, externalId);
    try {
      await updateExact(writer, chain.owned, externalWinner);
      await cleanup.beginTransaction();
      expect(await restoreOwnedSettings(cleanup, token(chain.predecessor, chain.owned))).toBe('skipped-not-owned');
      await cleanup.commit();
      expect(await readSettings(writer)).toEqual(externalWinner);
    } finally {
      await cleanup.rollback().catch(() => undefined);
      await restoreOriginal(chain.original);
    }
  }, 30_000);
});
