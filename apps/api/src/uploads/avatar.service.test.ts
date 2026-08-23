import { ConfigService } from '@nestjs/config';
import { AvatarKind, Role } from '../generated/prisma/client.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { AuditService } from '../audit/audit.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { mapGameSnapshot } from '../games/game-snapshot.mapper.js';
import { AvatarService } from './avatar.service.js';
import { DEFAULT_PRESET_AVATAR, PRESET_AVATARS } from './preset-avatars.js';

describe('AvatarService append-only uploads', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'poker-avatar-unit-'));
  });

  afterEach(async () => {
    sharp.cache(false);
    await rm(root, { recursive: true, force: true });
  });

  it('keeps every committed upload after replacement and preset selection', async () => {
    // Break caught: replacing/resetting an avatar deletes a file still referenced by a DB snapshot/backup.
    const userId = 'cm123';
    const oldName = `${userId}-01234567-89ab-4cde-8fab-0123456789ab.webp`;
    const oldPath = join(root, oldName);
    await writeFile(oldPath, 'old-upload');
    const now = new Date('2026-08-18T00:00:00.000Z');
    const state = {
      id: userId,
      username: 'avatar-user',
      normalizedUsername: 'avatar-user',
      nickname: '头像用户',
      activeNormalizedNickname: '头像用户',
      passwordHash: 'hash',
      role: Role.USER,
      rakeEnabled: true,
      avatarKind: AvatarKind.UPLOAD,
      avatarValue: oldName,
      isActive: true,
      mustChangePassword: false,
      createdById: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now
    };
    const transaction = {
      $queryRaw: vi.fn(async () => [{ ...state }]),
      user: {
        update: vi.fn(async ({ data }: { data: { avatarKind: AvatarKind; avatarValue: string } }) => {
          Object.assign(state, data);
          return { avatarKind: state.avatarKind, avatarValue: state.avatarValue };
        })
      }
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) => callback(transaction)),
      gamePlayer: { count: vi.fn(async () => 0) }
    } as unknown as PrismaService;
    const service = new AvatarService(
      prisma,
      { record: vi.fn() } as unknown as AuditService,
      new ConfigService({ AVATAR_ROOT: root })
    );
    const image = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#22c55e' }
    }).png().toBuffer();

    const uploaded = await service.upload(userId, {
      buffer: image,
      mimetype: 'image/png',
      originalname: 'avatar.png',
      size: image.byteLength
    });
    await expect(readFile(oldPath, 'utf8')).resolves.toBe('old-upload');
    await expect(readFile(join(root, uploaded.path!))).resolves.toBeInstanceOf(Buffer);

    await service.selectPreset(userId, 'preset-13');
    await expect(readFile(join(root, uploaded.path!))).resolves.toBeInstanceOf(Buffer);
    expect((prisma.gamePlayer as unknown as { count: ReturnType<typeof vi.fn> }).count)
      .not.toHaveBeenCalled();
  });

  it('exposes only the twelve new selectable presets', () => {
    // Break caught: the picker receives a catalog that its selection API rejects.
    expect(PRESET_AVATARS.map(({ id }) => id)).toEqual([
      'preset-13', 'preset-14', 'preset-15', 'preset-16', 'preset-17', 'preset-18',
      'preset-19', 'preset-20', 'preset-21', 'preset-22', 'preset-23', 'preset-24'
    ]);
    expect(DEFAULT_PRESET_AVATAR).toBe('preset-13');
  });

  it('rejects selecting a legacy preset while continuing to render it', async () => {
    // Break caught: programmatic service callers can select a legacy avatar even though HTTP rejects it.
    const now = new Date('2026-08-18T00:00:00.000Z');
    const userId = 'cm123';
    const state = {
      id: userId,
      username: 'avatar-user',
      normalizedUsername: 'avatar-user',
      nickname: '头像用户',
      activeNormalizedNickname: '头像用户',
      passwordHash: 'hash',
      role: Role.USER,
      rakeEnabled: true,
      avatarKind: AvatarKind.PRESET,
      avatarValue: 'preset-13',
      isActive: true,
      mustChangePassword: false,
      createdById: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now
    };
    const transaction = {
      $queryRaw: vi.fn(async () => [{ ...state }]),
      user: { update: vi.fn() }
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) => callback(transaction))
    } as unknown as PrismaService;
    const service = new AvatarService(
      prisma,
      { record: vi.fn() } as unknown as AuditService,
      new ConfigService({ AVATAR_ROOT: root })
    );

    await expect(service.selectPreset(userId, 'preset-01' as never)).rejects.toMatchObject({
      status: 400
    });

    expect(mapGameSnapshot({
      id: 'game-1',
      name: '遗留头像牌局',
      status: 'ACTIVE',
      version: 1,
      handPrice: 1n,
      rakeEnabled: true,
      startedAt: null,
      stoppedAt: null,
      players: [{
        id: 'player-1',
        userId,
        nicknameSnapshot: '头像用户',
        avatarKindSnapshot: AvatarKind.PRESET,
        avatarValueSnapshot: 'preset-01',
        seatNo: 1
      }],
      buyinEvents: []
    }).players[0]?.avatarUrl).toBe('/avatars/preset-01.webp');
  });
});
