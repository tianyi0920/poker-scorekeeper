import type { OnApplicationBootstrap } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PasswordService } from './password.service.js';

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

@Injectable()
export class BootstrapAdminService implements OnApplicationBootstrap {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(ConfigService) private readonly config: ConfigService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const activeSuperAdmins = await transaction.user.count({
        where: { role: Role.SUPER_ADMIN, isActive: true, deletedAt: null }
      });
      if (activeSuperAdmins > 0) return;

      const username = this.config.get<string>('BOOTSTRAP_ADMIN_USERNAME')?.trim();
      const nickname = this.config.get<string>('BOOTSTRAP_ADMIN_NICKNAME')?.trim();
      const password = this.config.get<string>('BOOTSTRAP_ADMIN_PASSWORD');
      if (!username || !nickname || !password) {
        if (this.config.get<string>('NODE_ENV') === 'production') {
          throw new Error('Bootstrap super admin configuration is required');
        }
        return;
      }

      await transaction.user.create({
        data: {
          username,
          normalizedUsername: normalize(username),
          nickname,
          activeNormalizedNickname: normalize(nickname),
          passwordHash: await this.passwords.hash(password),
          role: Role.SUPER_ADMIN,
          avatarValue: 'default',
          mustChangePassword: true
        }
      });
    });
  }
}
