import type { OnApplicationBootstrap } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role, type Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PasswordService } from './password.service.js';
import { DEFAULT_PRESET_AVATAR } from '../uploads/preset-avatars.js';

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

interface BootstrapConfiguration {
  username: string;
  nickname: string;
  password: string;
}

@Injectable()
export class BootstrapAdminService implements OnApplicationBootstrap {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(ConfigService) private readonly config: ConfigService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const testOnlyTarget = this.testOnlyTarget();
    await this.prisma.$transaction(async (transaction) => {
      const settingsLock = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM system_settings
        WHERE id = ${'singleton'}
        FOR UPDATE
      `;
      if (settingsLock.length !== 1) {
        throw new Error('System settings singleton is required');
      }

      if (testOnlyTarget !== null) {
        const configuration = this.requireBootstrapConfiguration();
        const existing = await transaction.user.findUnique({
          where: { normalizedUsername: testOnlyTarget }
        });
        if (existing !== null) {
          const matches = existing.username === configuration.username &&
            existing.nickname === configuration.nickname &&
            existing.role === Role.SUPER_ADMIN &&
            existing.isActive &&
            existing.deletedAt === null &&
            existing.mustChangePassword &&
            await this.passwords.verify(existing.passwordHash, configuration.password);
          if (!matches) throw new Error('Test-only bootstrap target conflicts with existing user');
          return;
        }
        await this.createBootstrapAdmin(transaction, configuration);
        return;
      }

      const activeSuperAdmins = await transaction.user.count({
        where: { role: Role.SUPER_ADMIN, isActive: true, deletedAt: null }
      });
      if (activeSuperAdmins > 0) return;

      const configuration = this.bootstrapConfiguration();
      if (configuration === null) {
        if (this.config.get<string>('NODE_ENV') === 'production') {
          throw new Error('Bootstrap super admin configuration is required');
        }
        return;
      }

      await this.createBootstrapAdmin(transaction, configuration);
    });
  }

  private testOnlyTarget(): string | null {
    const target = this.config.get<string>('TEST_ONLY_BOOTSTRAP_USERNAME')?.trim();
    if (!target) return null;
    if (this.config.get<string>('NODE_ENV') !== 'test') {
      throw new Error('Test-only bootstrap requires NODE_ENV=test');
    }
    const databaseUrl = this.config.get<string>('DATABASE_URL');
    if (databaseUrl === undefined) throw new Error('Test-only bootstrap requires DATABASE_URL');
    const database = new URL(databaseUrl).pathname.slice(1);
    if (!database.endsWith('_test')) {
      throw new Error(`Refusing test-only bootstrap on database: ${database}`);
    }
    const username = this.config.get<string>('BOOTSTRAP_ADMIN_USERNAME')?.trim();
    if (username === undefined || normalize(target) !== normalize(username)) {
      throw new Error('Test-only bootstrap target must match bootstrap username');
    }
    return normalize(target);
  }

  private bootstrapConfiguration(): BootstrapConfiguration | null {
    const username = this.config.get<string>('BOOTSTRAP_ADMIN_USERNAME')?.trim();
    const nickname = this.config.get<string>('BOOTSTRAP_ADMIN_NICKNAME')?.trim();
    const password = this.config.get<string>('BOOTSTRAP_ADMIN_PASSWORD');
    return username && nickname && password ? { username, nickname, password } : null;
  }

  private requireBootstrapConfiguration(): BootstrapConfiguration {
    const configuration = this.bootstrapConfiguration();
    if (configuration === null) {
      throw new Error('Test-only bootstrap requires complete bootstrap configuration');
    }
    return configuration;
  }

  private async createBootstrapAdmin(
    transaction: Prisma.TransactionClient,
    configuration: BootstrapConfiguration
  ): Promise<void> {
    await transaction.user.create({
      data: {
        username: configuration.username,
        normalizedUsername: normalize(configuration.username),
        nickname: configuration.nickname,
        activeNormalizedNickname: normalize(configuration.nickname),
        passwordHash: await this.passwords.hash(configuration.password),
        role: Role.SUPER_ADMIN,
        avatarValue: DEFAULT_PRESET_AVATAR,
        mustChangePassword: true
      }
    });
  }
}
