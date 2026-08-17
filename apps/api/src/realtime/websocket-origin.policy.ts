import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const ORIGIN_PROTOCOLS = new Set(['http:', 'https:']);

function configuredOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid websocket origin configuration');
  }
  if (
    !ORIGIN_PROTOCOLS.has(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.origin === 'null'
  ) {
    throw new Error('Invalid websocket origin configuration');
  }
  return url.origin;
}

@Injectable()
export class WebSocketOriginPolicy {
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(@Inject(ConfigService) config: ConfigService) {
    const candidates = [
      config.get<string>('PUBLIC_ORIGIN'),
      ...(config.get<string>('WS_ALLOWED_ORIGINS')?.split(',') ?? [])
    ];
    this.allowedOrigins = new Set(
      candidates
        .map((candidate) => candidate?.trim())
        .filter((candidate): candidate is string => candidate !== undefined && candidate !== '')
        .map(configuredOrigin)
    );
  }

  allows(origin: string | undefined): boolean {
    if (origin === undefined || origin === '' || origin !== origin.trim()) return false;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (
      !ORIGIN_PROTOCOLS.has(url.protocol) ||
      url.username !== '' ||
      url.password !== '' ||
      origin !== url.origin
    ) {
      return false;
    }
    return this.allowedOrigins.has(url.origin);
  }
}
