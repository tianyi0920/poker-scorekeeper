import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const guardPath = fileURLToPath(
  new URL('../../../scripts/database/assert-test-database.mjs', import.meta.url)
);
const createDatabasePath = fileURLToPath(
  new URL('../../../scripts/database/create-database.mjs', import.meta.url)
);

describe('database safety guard', () => {
  it('allows an isolated test database', () => {
    const result = spawnSync(process.execPath, [guardPath], {
      env: {
        ...process.env,
        DATABASE_URL: 'mysql://example:example@localhost:3306/poker_scorekeeper_test'
      },
      encoding: 'utf8'
    });

    expect(result.status).toBe(0);
  });

  it('rejects a database without the test suffix', () => {
    const result = spawnSync(process.execPath, [guardPath], {
      env: {
        ...process.env,
        DATABASE_URL: 'mysql://example:example@localhost:3306/poker_scorekeeper'
      },
      encoding: 'utf8'
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Refusing destructive test operation on database: poker_scorekeeper'
    );
  });
});

describe('database creation preflight', () => {
  it('accepts the production database name without connecting in validation mode', () => {
    const result = spawnSync(process.execPath, [createDatabasePath, '--validate-only'], {
      env: {
        ...process.env,
        DATABASE_URL: 'mysql://example:example@127.0.0.1:1/poker_scorekeeper'
      },
      encoding: 'utf8'
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('rejects an invalid database name before connecting', () => {
    const result = spawnSync(process.execPath, [createDatabasePath, '--validate-only'], {
      env: {
        ...process.env,
        DATABASE_URL: 'mysql://example:example@127.0.0.1:1/Bad-Name'
      },
      encoding: 'utf8'
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Invalid database name');
  });
});
