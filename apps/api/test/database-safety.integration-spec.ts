import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const guardPath = fileURLToPath(
  new URL('../../../scripts/database/assert-test-database.mjs', import.meta.url)
);
const createDatabasePath = fileURLToPath(
  new URL('../../../scripts/database/create-database.mjs', import.meta.url)
);

function productionCommandEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: databaseUrl };
  delete environment.NODE_ENV;
  return environment;
}

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
  it('rejects a local target even when NODE_ENV is absent', () => {
    const result = spawnSync(process.execPath, [createDatabasePath, '--validate-only'], {
      env: productionCommandEnvironment(
        'mysql://example:example@127.0.0.1:3306/poker_scorekeeper'
      ),
      encoding: 'utf8'
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('PRODUCTION_DATABASE_HOST_INVALID');
  });

  it('rejects a non-production database on the exact host before connecting', () => {
    const result = spawnSync(process.execPath, [createDatabasePath, '--validate-only'], {
      env: productionCommandEnvironment(
        'mysql://example:example@192.168.10.248:3306/poker_scorekeeper_test'
      ),
      encoding: 'utf8'
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('PRODUCTION_DATABASE_NAME_INVALID');
  });

  it('rejects an alternate remote target even when NODE_ENV is absent', () => {
    // Break caught: omitting NODE_ENV selected an attacker-controlled database target.
    const result = spawnSync(process.execPath, [createDatabasePath, '--validate-only'], {
      env: productionCommandEnvironment(
        'mysql://example:example@tianyi.wiki:8306/poker_scorekeeper'
      ),
      encoding: 'utf8'
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('PRODUCTION_DATABASE_HOST_INVALID');
    expect(result.stderr).not.toContain('mysql://');
    expect(result.stderr).not.toContain('example:example');
  });

  it('accepts only the exact production target when NODE_ENV is absent', () => {
    const result = spawnSync(process.execPath, [createDatabasePath, '--validate-only'], {
      env: productionCommandEnvironment(
        'mysql://example:example@192.168.10.248:3306/poker_scorekeeper'
      ),
      encoding: 'utf8'
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
