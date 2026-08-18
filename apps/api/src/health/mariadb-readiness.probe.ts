import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mariadb, { type ConnectionConfig } from 'mariadb';

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
  timeoutMilliseconds: number
): ConnectionConfig {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('Invalid readiness database configuration');
  }
  const port = Number(url.port || '3306');
  const database = decodeURIComponent(url.pathname.slice(1));
  if (
    (url.protocol !== 'mysql:' && url.protocol !== 'mariadb:') ||
    url.hostname === '' ||
    url.username === '' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    database === '' ||
    database.includes('/')
  ) {
    throw new Error('Invalid readiness database configuration');
  }
  return {
    host: url.hostname,
    port,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    connectTimeout: timeoutMilliseconds,
    socketTimeout: timeoutMilliseconds,
    queryTimeout: timeoutMilliseconds,
    connectAttributes: { program_name: 'poker-readiness' }
  };
}

@Injectable()
export class MariaDbReadinessProbe {
  private readonly options: ConnectionConfig;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(READINESS_CONNECTION_FACTORY) private readonly factory: ReadinessConnectionFactory
  ) {
    this.options = readinessConnectionConfig(
      config.get<string>('DATABASE_URL') ?? '',
      configuredTimeout(config)
    );
  }

  async check(): Promise<void> {
    let connection: ReadinessConnection | undefined;
    try {
      connection = await this.factory.connect(this.options);
      await connection.query('SELECT 1');
      await connection.end();
      connection = undefined;
    } catch (error) {
      connection?.destroy();
      throw error;
    }
  }
}
