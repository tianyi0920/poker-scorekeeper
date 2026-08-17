import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const guardPath = fileURLToPath(
  new URL('../../../scripts/database/assert-test-database.mjs', import.meta.url)
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
