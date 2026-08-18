import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConnectionConfig } from 'mariadb';

const DEFAULT_TLS_BASE_DIRECTORY = fileURLToPath(new URL('../../prisma/', import.meta.url));

export type MariaDbUrlConfig = Pick<
  ConnectionConfig,
  'host' | 'port' | 'user' | 'password' | 'database' | 'ssl'
>;

function invalidConfiguration(): never {
  throw new Error('Invalid database configuration');
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return invalidConfiguration();
  }
}

function hostWithoutIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function tlsConfiguration(
  url: URL,
  tlsBaseDirectory: string
): ConnectionConfig['ssl'] | undefined {
  const acceptance = url.searchParams.get('sslaccept');
  const certificatePath = url.searchParams.get('sslcert');
  const identityPath = url.searchParams.get('sslidentity');
  const identityPassword = url.searchParams.get('sslpassword');
  const tlsRequested = acceptance !== null || certificatePath !== null ||
    identityPath !== null || identityPassword !== null;
  if (!tlsRequested) return undefined;
  if (
    (acceptance !== null && acceptance !== 'strict' && acceptance !== 'accept_invalid_certs') ||
    (identityPassword !== null && identityPath === null)
  ) {
    throw new Error('Invalid database TLS configuration');
  }

  try {
    return {
      rejectUnauthorized: acceptance === 'strict',
      ...(certificatePath === null
        ? {}
        : { ca: readFileSync(resolve(tlsBaseDirectory, certificatePath)) }),
      ...(identityPath === null
        ? {}
        : { pfx: readFileSync(resolve(tlsBaseDirectory, identityPath)) }),
      ...(identityPassword === null ? {} : { passphrase: identityPassword })
    };
  } catch {
    throw new Error('Invalid database TLS configuration');
  }
}

export function buildMariaDbConnectionConfig(
  databaseUrl: string,
  tlsBaseDirectory: string = DEFAULT_TLS_BASE_DIRECTORY
): MariaDbUrlConfig {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return invalidConfiguration();
  }
  const port = Number(url.port || '3306');
  const database = decode(url.pathname.slice(1));
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
    return invalidConfiguration();
  }
  const ssl = tlsConfiguration(url, tlsBaseDirectory);
  return {
    host: hostWithoutIpv6Brackets(url.hostname),
    port,
    user: decode(url.username),
    password: decode(url.password),
    database,
    ...(ssl === undefined ? {} : { ssl })
  };
}
