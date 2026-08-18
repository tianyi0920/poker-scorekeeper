import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client.js';

type MariaDbPoolConfig = Exclude<ConstructorParameters<typeof PrismaMariaDb>[0], string>;

export function buildMariaDbPoolConfig(
  databaseUrl: string,
  nodeEnv: string | undefined
): MariaDbPoolConfig {
  const url = new URL(databaseUrl);
  const testOptions =
    nodeEnv === 'test'
      ? {
          connectionLimit: 3,
          minimumIdle: 1,
          connectTimeout: 10_000,
          acquireTimeout: 30_000
        }
      : { connectionLimit: 10 };

  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    ...testOptions
  };
}

export function buildPrismaTransactionOptions(
  nodeEnv: string | undefined
): { maxWait: number; timeout: number } | undefined {
  return nodeEnv === 'test' ? { maxWait: 15_000, timeout: 20_000 } : undefined;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ConfigService) config: ConfigService) {
    const nodeEnv = config.get<string>('NODE_ENV');
    const adapter = new PrismaMariaDb(
      buildMariaDbPoolConfig(config.getOrThrow<string>('DATABASE_URL'), nodeEnv)
    );
    const transactionOptions = buildPrismaTransactionOptions(nodeEnv);
    super(transactionOptions === undefined ? { adapter } : { adapter, transactionOptions });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
