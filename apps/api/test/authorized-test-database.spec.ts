import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CI_TEST_DATABASE_URL,
  TEST_DATABASE_TARGET_REFUSED,
  requireAuthorizedTestDatabase
} from './support/authorized-test-database.js';

const localUrl = 'mysql://local_user:local_password@tianyi.wiki:8306/poker_scorekeeper_test';
const ciEnvironment = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  DATABASE_URL: CI_TEST_DATABASE_URL
};

describe('authorized database-backed test target', () => {
  it('accepts only the exact local target outside GitHub Actions', () => {
    expect(requireAuthorizedTestDatabase({ DATABASE_URL: localUrl })).toMatchObject({
      hostname: 'tianyi.wiki',
      port: '8306',
      pathname: '/poker_scorekeeper_test'
    });
  });

  it('accepts only the exact public CI fixture with both GitHub Actions markers', () => {
    expect(requireAuthorizedTestDatabase(ciEnvironment).href).toBe(CI_TEST_DATABASE_URL);
  });

  it.each([
    {},
    { DATABASE_URL: 'mysql://local_user:local_password@tianyi.wiki:8306/poker_scorekeeper' },
    { DATABASE_URL: 'mysql://local_user:local_password@192.168.10.248:8306/poker_scorekeeper_test' },
    { DATABASE_URL: 'mysql://local_user:local_password@tianyi.wiki:3306/poker_scorekeeper_test' },
    { DATABASE_URL: 'mysql://tianyi.wiki:8306/poker_scorekeeper_test' },
    { DATABASE_URL: 'mysql://local%5Fuser:local_password@tianyi.wiki:8306/poker_scorekeeper_test' },
    { DATABASE_URL: 'mysql://local_user:local%5Fpassword@tianyi.wiki:8306/poker_scorekeeper_test' },
    { DATABASE_URL: 'mysql://local_user:local_password@TIANYI.WIKI:8306/poker_scorekeeper_test' },
    { CI: 'true', GITHUB_ACTIONS: 'true', DATABASE_URL: localUrl },
    { CI: 'true', DATABASE_URL: CI_TEST_DATABASE_URL },
    { GITHUB_ACTIONS: 'true', DATABASE_URL: CI_TEST_DATABASE_URL },
    {
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      DATABASE_URL: 'mysql://poker_ci:wrong@127.0.0.1:3306/poker_scorekeeper_ci_test'
    },
    {
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      DATABASE_URL: 'mysql://poker_ci:poker_ci@localhost:3306/poker_scorekeeper_ci_test'
    },
    {
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      DATABASE_URL: 'mysql://poker_ci:poker_ci@127.0.0.1:3306/poker_scorekeeper_test'
    }
  ])('rejects every alternate, encoded, incomplete, or production target without echoing it', (environment) => {
    let error: unknown;
    try {
      requireAuthorizedTestDatabase(environment);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ message: TEST_DATABASE_TARGET_REFUSED });
    expect(String(error)).not.toContain('mysql://');
    expect(String(error)).not.toContain('local_password');
    expect(String(error)).not.toContain('wrong');
  });

  it('keeps the public CI target synchronized with the command guard', () => {
    const guardSource = readFileSync(fileURLToPath(new URL(
      '../../../scripts/database/ci-test-environment.mjs',
      import.meta.url
    )), 'utf8');
    const match = guardSource.match(/CI_TEST_DATABASE_URL = '([^']+)'/);
    expect(match?.[1]).toBe(CI_TEST_DATABASE_URL);
  });

  it('routes every database-backed API integration and E2E file through the shared guard', () => {
    const testDirectory = fileURLToPath(new URL('.', import.meta.url));
    const databaseBackedFiles = readdirSync(testDirectory)
      .filter((name) => /\.(?:integration-spec|e2e-spec)\.ts$/.test(name))
      .filter((name) => name !== 'database-safety.integration-spec.ts')
      .map((name) => ({ name, source: readFileSync(new URL(name, import.meta.url), 'utf8') }))
      .filter(({ source }) => /\b(?:PrismaService|PrismaClient|mariadb\.createConnection)\b/.test(source));

    expect(databaseBackedFiles.length).toBeGreaterThan(0);
    for (const { name, source } of databaseBackedFiles) {
      expect(source, name).toMatch(
        /from '\.\/support\/authorized-test-database\.js';/
      );
      expect(source, name).toMatch(
        /^(?:const [A-Za-z][A-Za-z0-9]* = )?requireAuthorizedTestDatabase\(\);$/m
      );
      expect(source, name).not.toMatch(/endsWith\(['"]_test['"]\)/);
    }
  });
});
