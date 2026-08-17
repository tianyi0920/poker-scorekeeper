import { redactAuditValue } from './audit-redaction.js';

describe('audit redaction', () => {
  it('redacts sensitive key variants recursively without changing safe fields', () => {
    const input = {
      nickname: '王强',
      password: 'plain-secret',
      passwordHash: 'argon-hash',
      PASSWORD_HASH: 'upper-hash',
      new_password: 'replacement',
      nested: [
        { sessionToken: 'session-token', safe: true },
        { auth_token: 'auth-token', Cookie: 'cookie-value' },
        { cookieHeader: 'cookie-header', DATABASE_URL: 'mysql://credential' },
        { dbConnectionString: 'mysql://another-credential', authorization: 'Bearer token' },
        { db_url: 'opaque-db-address', api_key: 'api-key', credential_hash: 'stored-hash' }
      ]
    };

    expect(redactAuditValue(input)).toEqual({
      nickname: '王强',
      password: '[REDACTED]',
      passwordHash: '[REDACTED]',
      PASSWORD_HASH: '[REDACTED]',
      new_password: '[REDACTED]',
      nested: [
        { sessionToken: '[REDACTED]', safe: true },
        { auth_token: '[REDACTED]', Cookie: '[REDACTED]' },
        { cookieHeader: '[REDACTED]', DATABASE_URL: '[REDACTED]' },
        { dbConnectionString: '[REDACTED]', authorization: '[REDACTED]' },
        { db_url: '[REDACTED]', api_key: '[REDACTED]', credential_hash: '[REDACTED]' }
      ]
    });
  });

  it('redacts database connection URLs even when stored under a generic key', () => {
    expect(redactAuditValue({ endpoint: 'mysql://user:password@db.example/internal', count: 2 }))
      .toEqual({ endpoint: '[REDACTED]', count: 2 });
  });

  it('redacts semantic key variants without matching ordinary substrings', () => {
    expect(redactAuditValue({
      authorizationHeader: 'Bearer hidden',
      headerAuthorization: 'Bearer hidden',
      AUTHORIZATION_HEADER: 'Bearer hidden',
      'authorization-header': 'Bearer hidden',
      apiKeyValue: 'hidden-api-key',
      valueApiKey: 'hidden-api-key',
      API_KEY_VALUE: 'hidden-api-key',
      'api-key-value': 'hidden-api-key',
      secretValue: 'hidden-secret',
      valueSecret: 'hidden-secret',
      SECRET_VALUE: 'hidden-secret',
      'secret-value': 'hidden-secret',
      dbUrlValue: 'mysql://hidden',
      valueDbUrl: 'mysql://hidden',
      DB_URL_VALUE: 'mysql://hidden',
      'db-url-value': 'mysql://hidden',
      authorizationNote: 'approved by the owner',
      secretSanta: 'annual party',
      monkeyValue: 'banana',
      tokenizerMode: 'standard'
    })).toEqual({
      authorizationHeader: '[REDACTED]',
      headerAuthorization: '[REDACTED]',
      AUTHORIZATION_HEADER: '[REDACTED]',
      'authorization-header': '[REDACTED]',
      apiKeyValue: '[REDACTED]',
      valueApiKey: '[REDACTED]',
      API_KEY_VALUE: '[REDACTED]',
      'api-key-value': '[REDACTED]',
      secretValue: '[REDACTED]',
      valueSecret: '[REDACTED]',
      SECRET_VALUE: '[REDACTED]',
      'secret-value': '[REDACTED]',
      dbUrlValue: '[REDACTED]',
      valueDbUrl: '[REDACTED]',
      DB_URL_VALUE: '[REDACTED]',
      'db-url-value': '[REDACTED]',
      authorizationNote: 'approved by the owner',
      secretSanta: 'annual party',
      monkeyValue: 'banana',
      tokenizerMode: 'standard'
    });
  });

  it.each([
    'Bearer bearer-token',
    'Cookie: poker_session=cookie-token',
    'X-API-Key: api-key-token',
    'postgresql://user:password@db.example/internal'
  ])('redacts credential-shaped string values under generic keys: %s', (value) => {
    expect(redactAuditValue({ metadata: value })).toEqual({ metadata: '[REDACTED]' });
  });

  it('returns JSON-safe placeholders for cycles, invalid dates, and unreadable properties', () => {
    const cyclic: Record<string, unknown> = { safe: 'visible' };
    cyclic.self = cyclic;
    const unreadable: Record<string, unknown> = {};
    Object.defineProperty(unreadable, 'safe', {
      enumerable: true,
      get() { throw new Error('getter secret must not escape'); }
    });
    Object.defineProperty(unreadable, 'authorizationHeader', {
      enumerable: true,
      get() { throw new Error('credential must not be accessed'); }
    });
    const hostileProxy = new Proxy({}, {
      ownKeys() { throw new Error('proxy secret must not escape'); }
    });

    expect(redactAuditValue(cyclic)).toEqual({ safe: 'visible', self: '[CIRCULAR]' });
    expect(redactAuditValue(new Date('not-a-date'))).toBe('[INVALID_DATE]');
    expect(redactAuditValue(unreadable)).toEqual({
      safe: '[UNREADABLE]',
      authorizationHeader: '[REDACTED]'
    });
    expect(redactAuditValue(hostileProxy)).toBe('[UNREADABLE]');
  });

  it('does not mutate the source object', () => {
    const input = { profile: { passwordHash: 'unchanged-source' } };

    redactAuditValue(input);

    expect(input.profile.passwordHash).toBe('unchanged-source');
  });
});
