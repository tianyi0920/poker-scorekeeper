import { ConfigService } from '@nestjs/config';
import { AvatarKind, Role } from '../generated/prisma/client.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { AuditService } from '../audit/audit.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AvatarService } from './avatar.service.js';

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

    await service.selectPreset(userId, 'preset-01');
    await expect(readFile(join(root, uploaded.path!))).resolves.toBeInstanceOf(Buffer);
    expect((prisma.gamePlayer as unknown as { count: ReturnType<typeof vi.fn> }).count)
      .not.toHaveBeenCalled();
  });
});
