import type { ConfigService } from '@nestjs/config';
import { WebSocketOriginPolicy } from './websocket-origin.policy.js';

function policy(values: Record<string, string | undefined>): WebSocketOriginPolicy {
  return new WebSocketOriginPolicy({
    get: (key: string) => values[key]
  } as ConfigService);
}

describe('WebSocketOriginPolicy', () => {
  it('fails closed when no public or websocket origins are configured', () => {
    const origins = policy({});
    expect(origins.allows('https://poker.example.test')).toBe(false);
    expect(origins.allows(undefined)).toBe(false);
  });

  it('accepts only exact configured HTTP origins', () => {
    const origins = policy({
      PUBLIC_ORIGIN: 'https://poker.example.test/',
      WS_ALLOWED_ORIGINS: 'https://lan.example.test, http://localhost:3000'
    });
    expect(origins.allows('https://poker.example.test')).toBe(true);
    expect(origins.allows('https://lan.example.test')).toBe(true);
    expect(origins.allows('http://localhost:3000')).toBe(true);
    expect(origins.allows('https://poker.example.test.evil')).toBe(false);
    expect(origins.allows('https://poker.example.test/')).toBe(false);
  });

  it('accepts the HTTPS browser origin for the production socket and rejects HTTP', () => {
    const origins = policy({
      PUBLIC_ORIGIN: 'https://pk.tianyi.wiki',
      WS_ALLOWED_ORIGINS: ''
    });

    expect(origins.allows('https://pk.tianyi.wiki')).toBe(true);
    expect(origins.allows('http://pk.tianyi.wiki')).toBe(false);
  });

  it('rejects malformed configuration without echoing its value', () => {
    expect(() => policy({ PUBLIC_ORIGIN: 'private-malformed-value' }))
      .toThrowError('Invalid websocket origin configuration');
  });
});
