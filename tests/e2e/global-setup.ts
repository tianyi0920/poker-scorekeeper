import type { FullConfig } from '@playwright/test';
import { readdir, unlink } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { accounts, allFixtureAccounts } from './support/fixtures.js';
import { ownedAvatarFileName } from './support/avatar-cleanup.js';
import { openTestDatabase } from './support/database.js';
import { restoreOwnedSettings, type SettingSnapshot } from './support/settings-ownership.js';

const requireFromApi = createRequire(resolve('apps/api/package.json'));
const argon2 = requireFromApi('argon2') as {
  argon2id: number;
  hash(password: string, options: { type: number }): Promise<string>;
};

async function cleanupFixtures(setting: SettingSnapshot): Promise<void> {
  const connection = await openTestDatabase();
  const userIds = allFixtureAccounts.map(({ id }) => id);
  const fixtureUserIds = new Set(userIds);
  const avatarRoot = resolve('test-results/task18-runtime/avatars');
  const uploadedPaths: string[] = [];
  try {
    await connection.beginTransaction();
    const games = await connection.query(
      'SELECT id FROM games WHERE created_by_id IN (?, ?)',
      [accounts.admin.id, accounts['super-admin'].id]
    ) as Array<{ id: string }>;
    for (const { id: gameId } of games) {
      const players = await connection.query(
        'SELECT id FROM game_players WHERE game_id = ?', [gameId]
      ) as Array<{ id: string }>;
      const settlements = await connection.query(
        'SELECT id FROM settlements WHERE game_id = ?', [gameId]
      ) as Array<{ id: string }>;
      for (const { id: settlementId } of settlements) {
        await connection.query('DELETE FROM settlement_fee_allocations WHERE settlement_id = ?', [settlementId]);
        await connection.query('DELETE FROM settlement_results WHERE settlement_id = ?', [settlementId]);
      }
      await connection.query('DELETE FROM settlements WHERE game_id = ?', [gameId]);
      await connection.query('DELETE FROM settlement_drafts WHERE game_id = ?', [gameId]);
      await connection.query('DELETE FROM buyin_events WHERE game_id = ?', [gameId]);
      await connection.query('DELETE FROM active_player_locks WHERE game_id = ?', [gameId]);
      for (const { id: playerId } of players) {
        await connection.query('DELETE FROM settlement_fee_allocations WHERE game_player_id = ?', [playerId]);
        await connection.query('DELETE FROM settlement_results WHERE game_player_id = ?', [playerId]);
      }
      await connection.query('DELETE FROM game_players WHERE game_id = ?', [gameId]);
      await connection.query('DELETE FROM audit_logs WHERE entity_type = ? AND entity_id = ?', ['GAME', gameId]);
      await connection.query('DELETE FROM games WHERE id = ?', [gameId]);
    }
    for (const userId of userIds) {
      const rows = await connection.query(
        'SELECT avatar_kind, avatar_value FROM users WHERE id = ?', [userId]
      ) as Array<{ avatar_kind: string; avatar_value: string }>;
      if (rows[0]?.avatar_kind === 'UPLOAD') {
        const owned = ownedAvatarFileName(userId, rows[0].avatar_value, fixtureUserIds);
        if (owned !== undefined) uploadedPaths.push(owned);
      }
      await connection.query('DELETE FROM audit_logs WHERE actor_user_id = ? OR (entity_type = ? AND entity_id = ?)', [userId, 'USER', userId]);
      await connection.query('DELETE FROM auth_sessions WHERE user_id = ?', [userId]);
      await connection.query('DELETE FROM active_player_locks WHERE user_id = ?', [userId]);
    }
    await restoreOwnedSettings(connection, setting, accounts['super-admin'].id);
    for (const userId of [...userIds].reverse()) {
      await connection.query('DELETE FROM users WHERE id = ?', [userId]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }

  const entries = await readdir(avatarRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    for (const userId of fixtureUserIds) {
      const owned = ownedAvatarFileName(userId, entry.name, fixtureUserIds);
      if (owned !== undefined) {
        uploadedPaths.push(owned);
        break;
      }
    }
  }
  for (const relativePath of new Set(uploadedPaths)) {
    const target = resolve(avatarRoot, relativePath);
    if (!target.startsWith(`${avatarRoot}${sep}`)) throw new Error('Refusing avatar cleanup outside Task18 root');
    await unlink(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export default async function globalSetup(_config: FullConfig) {
  const connection = await openTestDatabase();
  let setting: SettingSnapshot | undefined;
  try {
    const settings = await connection.query(
      'SELECT rake_threshold, rake_bps, version, updated_by_id FROM system_settings WHERE id = ?',
      ['singleton']
    ) as SettingSnapshot[];
    setting = settings[0];
    if (!setting) throw new Error('Task18 requires the migrated system_settings singleton');
    const ids = allFixtureAccounts.map(({ id }) => id);
    for (const id of ids) {
      const existing = await connection.query('SELECT id FROM users WHERE id = ?', [id]) as unknown[];
      if (existing.length !== 0) throw new Error('Task18 runId collision; refusing to reuse fixture rows');
    }
    await connection.beginTransaction();
    for (const account of allFixtureAccounts) {
      const passwordHash = await argon2.hash(account.password, { type: argon2.argon2id });
      await connection.query(
        `INSERT INTO users (
          id, username, normalized_username, nickname, active_normalized_nickname,
          password_hash, role, rake_enabled, avatar_kind, avatar_value,
          is_active, must_change_password, created_by_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, 'PRESET', 'preset-01', TRUE, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
        [
          account.id,
          account.username,
          account.username.normalize('NFKC').toLowerCase(),
          account.nickname,
          account.nickname.normalize('NFKC').toLocaleLowerCase('zh-CN'),
          passwordHash,
          account.role,
          account === accounts['forced-password'],
          account === accounts['super-admin'] ? null : accounts['super-admin'].id
        ]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    await connection.end();
  }

  return async () => cleanupFixtures(setting!);
}
