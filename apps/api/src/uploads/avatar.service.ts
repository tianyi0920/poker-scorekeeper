import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PresetAvatarId } from '@poker/contracts';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import sharp from 'sharp';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import {
  badRequest,
  notFound,
  payloadTooLarge,
  unsupportedMediaType
} from '../common/errors/app-error.js';
import { AvatarKind } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  assertCanManageUser,
  lockUsersInOrder,
  requireCurrentActor
} from '../users/user-policy.js';
import { DEFAULT_PRESET_AVATAR } from './preset-avatars.js';

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const MAX_AVATAR_DIMENSION = 4096;
const MAX_AVATAR_PIXELS = MAX_AVATAR_DIMENSION * MAX_AVATAR_DIMENSION;

const MIME_BY_FORMAT: Readonly<Record<string, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp'
};

export interface UploadedAvatarFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

export interface AvatarResponse {
  avatarKind: 'PRESET' | 'UPLOAD';
  avatarValue: string;
  path?: string;
}

@Injectable()
export class AvatarService {
  private readonly avatarRoot: string;
  private readonly logger = new Logger(AvatarService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ConfigService) config: ConfigService
  ) {
    this.avatarRoot = resolve(
      config.get<string>('AVATAR_ROOT') ?? join(process.cwd(), 'data', 'avatars')
    );
  }

  async selectPreset(userId: string, presetId: PresetAvatarId): Promise<AvatarResponse> {
    return this.replaceWithPreset(userId, presetId);
  }

  async upload(userId: string, file: UploadedAvatarFile | undefined): Promise<AvatarResponse> {
    if (file === undefined) throw badRequest('VALIDATION_ERROR');
    if (file.size > MAX_AVATAR_BYTES) throw payloadTooLarge('AVATAR_TOO_LARGE');
    await this.validateImage(file);
    await mkdir(this.avatarRoot, { recursive: true });

    const filename = `${userId}-${randomUUID()}.webp`;
    const temporaryPath = join(this.avatarRoot, `.${filename}.tmp`);
    const finalPath = join(this.avatarRoot, filename);
    let finalExists = false;
    let committed = false;
    try {
      await sharp(file.buffer, { limitInputPixels: MAX_AVATAR_PIXELS, failOn: 'warning' })
        .rotate()
        .resize(256, 256, { fit: 'cover', position: 'centre' })
        .webp({ quality: 86 })
        .toFile(temporaryPath);
      await rename(temporaryPath, finalPath);
      finalExists = true;

      const previous = await this.prisma.$transaction(async (transaction) => {
        const locked = await lockUsersInOrder(transaction, [userId]);
        const target = locked.get(userId) ?? null;
        if (target === null || target.deletedAt !== null) throw notFound('NOT_FOUND');
        requireCurrentActor(locked, userId);
        await transaction.user.update({
          where: { id: userId },
          data: { avatarKind: AvatarKind.UPLOAD, avatarValue: filename }
        });
        return { kind: target.avatarKind, value: target.avatarValue };
      });
      committed = true;

      await this.deleteUploadedFile(userId, previous.kind, previous.value);
      return { avatarKind: 'UPLOAD', avatarValue: filename, path: filename };
    } catch (error) {
      if (finalExists && !committed) await this.cleanupFile(finalPath);
      throw error;
    } finally {
      await this.cleanupFile(temporaryPath);
    }
  }

  async resetByAdministrator(actor: AuthUser, userId: string): Promise<AvatarResponse> {
    return this.replaceWithPreset(
      userId,
      DEFAULT_PRESET_AVATAR,
      actor
    );
  }

  private async replaceWithPreset(
    userId: string,
    presetId: PresetAvatarId,
    actor?: AuthUser
  ): Promise<AvatarResponse> {
    const previous = await this.prisma.$transaction(async (transaction) => {
      const locked = await lockUsersInOrder(transaction, actor === undefined
        ? [userId]
        : [actor.id, userId]);
      const target = locked.get(userId) ?? null;
      if (target === null || target.deletedAt !== null) throw notFound('NOT_FOUND');
      if (actor === undefined) {
        requireCurrentActor(locked, userId);
      } else {
        const currentActor = requireCurrentActor(locked, actor.id);
        assertCanManageUser(currentActor, target, { operation: 'reset-avatar' });
      }
      const updated = await transaction.user.update({
        where: { id: userId },
        data: { avatarKind: AvatarKind.PRESET, avatarValue: presetId },
        select: { avatarKind: true, avatarValue: true }
      });
      if (actor !== undefined) {
        await this.audit.record(transaction, {
          actorUserId: actor.id,
          action: 'USER_AVATAR_RESET',
          entityType: 'USER',
          entityId: userId,
          before: { avatarKind: target.avatarKind, avatarValue: target.avatarValue },
          after: updated
        });
      }
      return { kind: target.avatarKind, value: target.avatarValue };
    });
    await this.deleteUploadedFile(userId, previous.kind, previous.value);
    return { avatarKind: 'PRESET', avatarValue: presetId };
  }

  private async validateImage(file: UploadedAvatarFile): Promise<void> {
    try {
      const metadata = await sharp(file.buffer, {
        limitInputPixels: MAX_AVATAR_PIXELS,
        failOn: 'warning'
      }).metadata();
      const width = metadata.width ?? 0;
      const height = metadata.height ?? 0;
      const expectedMime = metadata.format === undefined
        ? undefined
        : MIME_BY_FORMAT[metadata.format];
      if (
        expectedMime === undefined ||
        file.mimetype !== expectedMime ||
        width < 1 ||
        height < 1 ||
        width > MAX_AVATAR_DIMENSION ||
        height > MAX_AVATAR_DIMENSION ||
        width * height > MAX_AVATAR_PIXELS
      ) {
        throw unsupportedMediaType('AVATAR_UNSUPPORTED');
      }
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'AVATAR_UNSUPPORTED'
      ) {
        throw error;
      }
      throw unsupportedMediaType('AVATAR_UNSUPPORTED');
    }
  }

  private async deleteUploadedFile(
    userId: string,
    kind: AvatarKind,
    value: string
  ): Promise<void> {
    if (kind !== AvatarKind.UPLOAD || !this.isControlledFilename(userId, value)) return;
    if (await this.isHistoricalAvatar(value)) return;
    sharp.cache(false);
    await this.cleanupFile(join(this.avatarRoot, value));
  }

  private async isHistoricalAvatar(value: string): Promise<boolean> {
    try {
      return await this.prisma.gamePlayer.count({
        where: {
          avatarKindSnapshot: AvatarKind.UPLOAD,
          avatarValueSnapshot: value
        }
      }) > 0;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : 'UNKNOWN';
      this.logger.warn(`Avatar reference check failed for ${basename(value)} (${code})`);
      return true;
    }
  }

  private isControlledFilename(userId: string, value: string): boolean {
    if (basename(value) !== value || !value.startsWith(`${userId}-`)) return false;
    const uuid = value.slice(userId.length + 1, -'.webp'.length);
    return value.endsWith('.webp') &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid);
  }

  private async cleanupFile(path: string): Promise<void> {
    try {
      await rm(path, { force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : 'UNKNOWN';
      this.logger.warn(`Avatar cleanup failed for ${basename(path)} (${code})`);
    }
  }
}
