import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mariadb, { type ConnectionConfig } from 'mariadb';
import { buildMariaDbConnectionConfig } from '../prisma/mariadb-connection-config.js';

export interface ReadinessConnection {
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  destroy(): void;
}

export interface ReadinessConnectionFactory {
  connect(options: ConnectionConfig): Promise<ReadinessConnection>;
}

export const READINESS_CONNECTION_FACTORY = Symbol('READINESS_CONNECTION_FACTORY');

export const mariaDbReadinessConnectionFactory: ReadinessConnectionFactory = {
  connect: (options) => mariadb.createConnection(options)
};

function configuredTimeout(config: ConfigService): number {
  const value = Number(config.get<string>('READINESS_TIMEOUT_MS') ?? '2000');
  return Number.isInteger(value) && value >= 10 && value <= 10_000 ? value : 2_000;
}

export function readinessConnectionConfig(
  databaseUrl: string,
  timeoutMilliseconds: number,
  tlsBaseDirectory?: string
): ConnectionConfig {
  return {
    ...buildMariaDbConnectionConfig(databaseUrl, tlsBaseDirectory),
    connectTimeout: timeoutMilliseconds,
    socketTimeout: timeoutMilliseconds,
    connectAttributes: { program_name: 'poker-readiness' }
  };
}

@Injectable()
export class MariaDbReadinessProbe {
  private readonly options: ConnectionConfig;
  private readonly timeoutMilliseconds: number;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(READINESS_CONNECTION_FACTORY) private readonly factory: ReadinessConnectionFactory
  ) {
    this.timeoutMilliseconds = configuredTimeout(config);
    this.options = readinessConnectionConfig(
      config.get<string>('DATABASE_URL') ?? '',
      this.timeoutMilliseconds
    );
  }

  async check(): Promise<void> {
    let connection: ReadinessConnection | undefined;
    let destroyed = false;
    const destroy = () => {
      if (connection !== undefined && !destroyed) {
        destroyed = true;
        connection.destroy();
      }
    };
    try {
      connection = await this.factory.connect(this.options);
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          callback();
        };
        const timer = setTimeout(() => {
          finish(() => {
            destroy();
            reject(new Error('Readiness query timeout'));
          });
        }, this.timeoutMilliseconds);
        timer.unref();
        void connection?.query('SELECT 1').then(
          () => finish(resolve),
          (error: unknown) => finish(() => reject(error))
        );
      });
      await connection.end();
      connection = undefined;
    } catch (error) {
      destroy();
      throw error;
    }
  }
}
