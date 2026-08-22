import { describe, expect, it } from 'vitest';
import {
  hstsSetting,
  trustProxySetting
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
});
