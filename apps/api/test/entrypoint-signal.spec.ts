import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const entrypoint = join(repositoryRoot, 'scripts', 'docker', 'entrypoint.sh');
const bash = process.env.BASH_PATH ?? 'bash';

function shellPath(path: string): string {
  if (process.platform !== 'win32') return path;
  return path.replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`)
    .replaceAll('\\', '/');
}

async function executable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents.replaceAll('\r\n', '\n'));
  await chmod(path, 0o755);
}

describe('container entrypoint signal forwarding', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'poker-entrypoint-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('executes an explicit one-off command without running migrations or starting the API', async () => {
    // Break caught: docker compose run preflight mutates the database before the guard can execute.
    const bin = join(root, 'bin');
    await mkdir(bin);
    const migrationStarted = join(root, 'migration.started');
    const apiStarted = join(root, 'api.started');
    const commandResult = join(root, 'command.result');
    await executable(join(bin, 'pnpm'), `#!/bin/sh
printf '%s\n' started > "$MIGRATION_STARTED_FILE"
exit 90
`);
    await executable(join(bin, 'node'), `#!/bin/sh
printf '%s\n' started > "$API_STARTED_FILE"
exit 91
`);
    await executable(join(bin, 'production-probe'), `#!/bin/sh
printf '%s\n' "$*" > "$COMMAND_RESULT_FILE"
exit 23
`);

    const result = spawnSync(
      bash,
      [shellPath(entrypoint), 'production-probe', 'safe-argument'],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PATH: `${shellPath(bin)}:/usr/bin:/bin`,
          MIGRATION_STARTED_FILE: shellPath(migrationStarted),
          API_STARTED_FILE: shellPath(apiStarted),
          COMMAND_RESULT_FILE: shellPath(commandResult)
        },
        encoding: 'utf8'
      }
    );

    expect(result.status, result.stderr).toBe(23);
    expect((await readFile(commandResult, 'utf8')).trim()).toBe('safe-argument');
    await expect(readFile(migrationStarted)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(apiStarted)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('forwards TERM to an in-flight migration child and never starts the API', async () => {
    // Break caught: TERM stops only the shell while Prisma migration remains orphaned.
    const bin = join(root, 'bin');
    await mkdir(bin);
    await executable(join(bin, 'pnpm'), `#!/bin/sh
printf '%s\n' "$$" > "$MIGRATION_PID_FILE"
printf '%s\n' ready > "$MIGRATION_READY_FILE"
trap 'printf "%s\\n" TERM > "$MIGRATION_SIGNAL_FILE"; exit 143' TERM
while [ ! -f "$MIGRATION_RELEASE_FILE" ]; do
  "$NODE_DELAY" -e 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)'
done
exit 0
`);
    await executable(join(bin, 'node'), `#!/bin/sh
printf '%s\n' started > "$API_STARTED_FILE"
exit 0
`);
    const driver = join(root, 'driver.sh');
    await executable(driver, `#!/bin/sh
set -eu
"$BASH_PATH" "$ENTRYPOINT" &
entrypoint_pid=$!
attempt=0
while [ ! -f "$MIGRATION_READY_FILE" ] && [ "$attempt" -lt 20 ]; do
  "$NODE_DELAY" -e 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)'
  attempt=$((attempt + 1))
done
[ -f "$MIGRATION_READY_FILE" ] || exit 20
kill -TERM "$entrypoint_pid"
attempt=0
while [ ! -f "$MIGRATION_SIGNAL_FILE" ] && [ "$attempt" -lt 20 ]; do
  "$NODE_DELAY" -e 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)'
  attempt=$((attempt + 1))
done
: > "$MIGRATION_RELEASE_FILE"
if [ ! -f "$MIGRATION_SIGNAL_FILE" ]; then
  wait "$entrypoint_pid" 2>/dev/null || true
  exit 21
fi
wait "$entrypoint_pid" 2>/dev/null || status=$?
[ "\${status:-0}" -eq 143 ]
[ ! -f "$API_STARTED_FILE" ]
`);

    const signalFile = join(root, 'migration.signal');
    const result = spawnSync(bash, [shellPath(driver)], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PATH: `${shellPath(bin)}:/usr/bin:/bin`,
        BASH_PATH: shellPath(bash),
        NODE_DELAY: shellPath(process.execPath),
        ENTRYPOINT: shellPath(entrypoint),
        MIGRATION_PID_FILE: shellPath(join(root, 'migration.pid')),
        MIGRATION_READY_FILE: shellPath(join(root, 'migration.ready')),
        MIGRATION_SIGNAL_FILE: shellPath(signalFile),
        MIGRATION_RELEASE_FILE: shellPath(join(root, 'migration.release')),
        API_STARTED_FILE: shellPath(join(root, 'api.started'))
      },
      encoding: 'utf8',
      timeout: 10_000
    });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect((await readFile(signalFile, 'utf8')).trim()).toBe('TERM');
  });

  it('preserves a migration failure status and never starts the API', async () => {
    // Break caught: shell negation turns a failed migration into a successful container exit.
    const bin = join(root, 'bin');
    await mkdir(bin);
    await executable(join(bin, 'pnpm'), '#!/bin/sh\nexit 7\n');
    const apiStarted = join(root, 'api.started');
    await executable(join(bin, 'node'), `#!/bin/sh
printf '%s\n' started > "$API_STARTED_FILE"
exit 0
`);
    const result = spawnSync(bash, [shellPath(entrypoint)], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PATH: `${shellPath(bin)}:/usr/bin:/bin`,
        API_STARTED_FILE: shellPath(apiStarted)
      },
      encoding: 'utf8'
    });

    expect(result.status, result.stderr).toBe(7);
    await expect(readFile(apiStarted)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
