import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error The production boundary is intentionally a small, plain ESM script.
import { validateCiTestEnvironment } from '../../../scripts/database/ci-test-environment.mjs';
// @ts-expect-error The production boundary is intentionally a small, plain ESM script.
import { runWithCiTestEnvironment } from '../../../scripts/database/run-with-ci-test-env.mjs';

const target = 'mysql://127.0.0.1:3306/poker_scorekeeper_ci_test';
const validEnvironment = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  DATABASE_URL: target
};

function refused(environment: Record<string, string | undefined>): void {
  expect(() => validateCiTestEnvironment(environment)).toThrow('CI_TEST_DATABASE_TARGET_REFUSED');
}

describe('GitHub Actions CI test database target', () => {
  it('returns the exact loopback CI schema URL when all CI markers match', () => {
    expect(validateCiTestEnvironment(validEnvironment)).toBe(target);
  });

  it('rejects production and remote database targets', () => {
    for (const databaseUrl of [
      'mysql://127.0.0.1:3306/poker_scorekeeper',
      'mysql://127.0.0.1:3306/poker_scorekeeper_test',
      'mysql://tianyi.wiki:3306/poker_scorekeeper_ci_test',
      'mysql://192.168.10.248:3306/poker_scorekeeper_ci_test'
    ]) {
      refused({ ...validEnvironment, DATABASE_URL: databaseUrl });
    }
  });

  it('rejects missing CI markers and a poisoned parent DATABASE_URL', () => {
    refused({ ...validEnvironment, CI: undefined });
    refused({ ...validEnvironment, GITHUB_ACTIONS: undefined });
    refused({
      ...validEnvironment,
      DATABASE_URL: 'mysql://poisoned:poisoned@127.0.0.1:3306/not_the_test_database'
    });
  });

  it('rejects encoded host tricks and ambiguous URL components', () => {
    for (const databaseUrl of [
      'mysql://127.0.0.1%2eexample.com:3306/poker_scorekeeper_ci_test',
      'mysql://2130706433:3306/poker_scorekeeper_ci_test',
      `${target}?ssl=true`,
      `${target}?`,
      `${target}#poker_scorekeeper`,
      `${target}#`,
      'mysql://user:password@127.0.0.1:3306/poker_scorekeeper_ci_test'
    ]) {
      refused({ ...validEnvironment, DATABASE_URL: databaseUrl });
    }
  });
});

describe('guarded CI test command runner', () => {
  it('passes only the validated target to a command and never uses a shell', async () => {
    const child = new EventEmitter();
    const spawnCommand = vi.fn(() => child);
    const run = runWithCiTestEnvironment({
      environment: validEnvironment,
      args: ['node', '-e', 'process.exit(7)'],
      spawnCommand
    });

    child.emit('exit', 7, null);
    await expect(run).resolves.toMatchObject({ code: 7, signal: null });
    expect(spawnCommand).toHaveBeenCalledWith(
      'node',
      ['-e', 'process.exit(7)'],
      expect.objectContaining({ shell: false, env: expect.objectContaining({ DATABASE_URL: target }) })
    );
  });

  it('connects only for explicit check-only and executes SELECT 1', async () => {
    const query = vi.fn().mockResolvedValue([{ 1: 1 }]);
    const end = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn().mockResolvedValue({ query, end });

    await expect(runWithCiTestEnvironment({
      environment: validEnvironment,
      args: ['--check-only'],
      connect
    })).resolves.toMatchObject({ mode: 'check-only', code: 0 });
    expect(connect).toHaveBeenCalledWith(target);
    expect(query).toHaveBeenCalledWith('SELECT 1');
    expect(end).toHaveBeenCalledOnce();
  });

  it('returns a child signal so the CLI can preserve it', async () => {
    const child = new EventEmitter();
    const run = runWithCiTestEnvironment({
      environment: validEnvironment,
      args: ['node', '-e', 'process.kill(process.pid, "SIGTERM")'],
      spawnCommand: vi.fn(() => child)
    });

    child.emit('exit', null, 'SIGTERM');
    await expect(run).resolves.toMatchObject({ code: null, signal: 'SIGTERM' });
  });
});
