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

  it('does not mutate the source object', () => {
    const input = { profile: { passwordHash: 'unchanged-source' } };

    redactAuditValue(input);

    expect(input.profile.passwordHash).toBe('unchanged-source');
  });
});
