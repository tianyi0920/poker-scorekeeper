import { describe, expect, it, vi } from 'vitest';
import { GamesController } from './games/games.controller.js';
import { UsersController } from './users/users.controller.js';

const actor = {
  id: 'admin-id',
  username: 'admin',
  nickname: 'Admin',
  role: 'SUPER_ADMIN',
  mustChangePassword: false,
  avatarKind: 'PRESET',
  avatarValue: 'preset-01'
} as const;

describe('production acceptance ownership headers', () => {
  it('returns an exact Location header for a newly created user', async () => {
    const created = { id: 'owned-user-id' };
    const controller = new UsersController({ create: vi.fn(async () => created) } as never);
    const setHeader = vi.fn();

    await expect(controller.create(actor, {
      username: 'accept-run', nickname: 'Run', initialPassword: 'password',
      role: 'USER', rakeEnabled: false
    }, { setHeader } as never)).resolves.toBe(created);

    expect(setHeader).toHaveBeenCalledWith('Location', '/api/users/owned-user-id');
  });

  it('returns an exact Location header for a newly created game', async () => {
    const created = { id: 'owned-game-id' };
    const controller = new GamesController(
      { create: vi.fn(async () => created) } as never,
      {} as never,
      {} as never
    );
    const setHeader = vi.fn();

    await expect(controller.create(actor, {
      name: 'production-check', handPrice: '300', rakeEnabled: false
    }, { setHeader } as never)).resolves.toBe(created);

    expect(setHeader).toHaveBeenCalledWith('Location', '/api/games/owned-game-id');
  });
});
