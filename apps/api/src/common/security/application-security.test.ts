import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import {
  hstsSetting,
  trustProxySetting,
  websocketCspSources
} from './application-security.js';

describe('application transport security', () => {
  it('never trusts forwarded client addresses without a reverse proxy', () => {
    expect(trustProxySetting()).toBe(false);
  });

  it('disables HSTS for a production HTTP origin', () => {
    expect(hstsSetting({
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'http://pk.tianyi.wiki'
    })).toBe(false);
  });

  it('retains HSTS for a production HTTPS origin', () => {
    expect(hstsSetting({
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'https://pk.tianyi.wiki'
    })).toEqual({ maxAge: 31_536_000, includeSubDomains: true });
  });

  it('disables HSTS outside production', () => {
    expect(hstsSetting({
      NODE_ENV: 'development',
      PUBLIC_ORIGIN: 'https://pk.tianyi.wiki'
    })).toBe(false);
  });

  it('converts an HTTPS public origin to the matching WSS CSP source', () => {
    expect(websocketCspSources({
      PUBLIC_ORIGIN: 'https://pk.tianyi.wiki'
    })).toEqual(['wss://pk.tianyi.wiki']);
  });

  it('keeps the ExtremeSpace production example on the canonical HTTPS socket origin', () => {
    const environment = parse(readFileSync(
      new URL('../../../../../.env.extremespace.example', import.meta.url)
    ));

    expect(environment.PUBLIC_ORIGIN).toBe('https://pk.tianyi.wiki');
    expect(environment.WS_ALLOWED_ORIGINS).toBe('https://pk.tianyi.wiki');
  });
});
