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
    'PASSWORDHASH',
    'passwordhash',
    'password_hash',
    'password-hash',
    'passwordHash',
    'SESSIONTOKEN',
    'sessiontoken',
    'session_token',
    'session-token',
    'sessionToken',
    'COOKIEHEADER',
    'cookieheader',
    'cookie_header',
    'cookie-header',
    'cookieHeader',
    'AUTHHEADER',
    'authheader',
    'auth_header',
    'auth-header',
    'authHeader'
  ])('redacts compact and segmented credential key: %s', (key) => {
    expect(redactAuditValue({ [key]: 'credential' })).toEqual({ [key]: '[REDACTED]' });
  });

  it('preserves the must-change-password state without allowing password hashes through', () => {
    expect(redactAuditValue({
      mustChangePassword: false,
      must_change_password: true,
      passwordhash: 'hash-one',
      PASSWORDHASH: 'hash-two'
    })).toEqual({
      mustChangePassword: false,
      must_change_password: true,
      passwordhash: '[REDACTED]',
      PASSWORDHASH: '[REDACTED]'
    });
    expect(redactAuditValue({ mustChangePassword: 'not-a-boolean' }))
      .toEqual({ mustChangePassword: '[REDACTED]' });
  });

  it.each([
    'Bearer bearer-token',
    'Cookie: poker_session=cookie-token',
    'X-API-Key: api-key-token',
    'postgresql://user:password@db.example/internal',
    'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    'agent Authorization: Bearer bearer-token',
    'agent Cookie: poker_session=cookie-token',
    'agent X-API-Key: api-key-token',
    'User ID=db-user;Password=db-password;Server=db.example'
  ])('redacts credential-shaped string values under generic keys: %s', (value) => {
    expect(redactAuditValue({ metadata: value })).toEqual({ metadata: '[REDACTED]' });
  });

  it.each([
    'agent Bearer opaque-token-1234567890',
    'agent Basic dXNlcjpwYXNzd29yZA==',
    'dsn=mysql://user:password@db.example/internal',
    'endpoint:postgresql://user:password@db.example/internal',
    'jdbc:mysql://user:password@db.example/internal',
    'jdbc:mariadb://user:password@db.example/internal',
    'jdbc:postgresql://user:password@db.example/internal'
  ])('redacts embedded credential and database values under generic keys: %s', (value) => {
    expect(redactAuditValue({ metadata: value })).toEqual({ metadata: '[REDACTED]' });
  });

  it.each([
    'basic plan',
    'bearer animal',
    'ordinary endpoint status'
  ])('keeps non-credential text under generic keys: %s', (value) => {
    expect(redactAuditValue({ metadata: value })).toEqual({ metadata: value });
  });

  it('replaces content beyond the maximum traversal depth', () => {
    let deep: Record<string, unknown> = { leaf: 'must-not-be-reached' };
    for (let index = 0; index < 128; index += 1) deep = { child: deep };

    expect(JSON.stringify(redactAuditValue(deep))).toContain('[MAX_DEPTH_EXCEEDED]');
  });

  it('replaces objects that exceed the maximum node budget', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 12_000 }, (_, index) => [`field${index}`, index])
    );
    const result = redactAuditValue(wide);

    expect(typeof result).toBe('string');
    expect(result).toBe('[MAX_NODES_EXCEEDED]');
  });

  it('rejects a large sparse array before allocating the output array', () => {
    const sparse = new Array<string>(1_000_000);
    sparse[999_999] = 'must-not-be-reached';
    const result = redactAuditValue(sparse);

    expect(typeof result).toBe('string');
    expect(result).toBe('[MAX_ARRAY_LENGTH_EXCEEDED]');
  });

  it('replaces strings beyond the maximum audit value length', () => {
    expect(redactAuditValue('x'.repeat(20_000)) === '[MAX_STRING_LENGTH_EXCEEDED]')
      .toBe(true);
  });

  it('keeps an ordinary browser user agent intact', () => {
    const userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15';

    expect(redactAuditValue(userAgent)).toBe(userAgent);
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
