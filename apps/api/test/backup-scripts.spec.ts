import { spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const backupScript = join(repositoryRoot, 'scripts', 'backup', 'backup.sh');
const restoreScript = join(repositoryRoot, 'scripts', 'backup', 'restore.sh');
const restoreInputGuard = join(repositoryRoot, 'scripts', 'backup', 'restore-input-guard.mjs');
const bash = process.env.BASH_PATH ?? 'bash';
const controlledAvatarName = 'cm123-01234567-89ab-4cde-8fab-0123456789ab.webp';

function shellPath(path: string): string {
  if (process.platform !== 'win32') return path;
  return path.replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`)
    .replaceAll('\\', '/');
}

interface RestoreTarEntry {
  name: string;
  type?: string;
  contents?: Buffer;
}

function tarOctal(value: number, width: number): Buffer {
  return Buffer.from(value.toString(8).padStart(width - 1, '0') + '\0', 'ascii');
}

function restoreTarArchive(entries: RestoreTarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const contents = entry.contents ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    tarOctal(entry.type === '5' ? 0o755 : 0o644, 8).copy(header, 100);
    tarOctal(0, 8).copy(header, 108);
    tarOctal(0, 8).copy(header, 116);
    tarOctal(contents.byteLength, 12).copy(header, 124);
    tarOctal(0, 12).copy(header, 136);
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? '0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    Buffer.from(checksum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(header, 148);
    blocks.push(header, contents);
    const padding = (512 - (contents.byteLength % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function runScript(script: string, env: Record<string, string>) {
  return spawnSync(bash, env.DEBUG_SHELL === '1' ? ['-x', shellPath(script)] : [shellPath(script)], {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function runScriptAsync(script: string, env: Record<string, string>) {
  return new Promise<{ status: number | null; stderr: string; stdout: string }>((resolveResult) => {
    const child = spawn(bash, [shellPath(script)], {
      cwd: repositoryRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('close', (status) => resolveResult({ status, stderr, stdout }));
  });
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await stat(path).then(() => true).catch(() => false)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents.replaceAll('\r\n', '\n'));
  await chmod(path, 0o755);
}

async function createFakeCommands(root: string): Promise<{ bin: string; log: string }> {
  const bin = join(root, 'bin');
  const log = join(root, 'commands.log');
  await mkdir(bin, { recursive: true });
  await writeExecutable(join(bin, 'mysqldump'), `#!/bin/sh
printf 'mysqldump' >> "$FAKE_COMMAND_LOG"
for value in "$@"; do printf ' <%s>' "$value" >> "$FAKE_COMMAND_LOG"; done
printf '\n' >> "$FAKE_COMMAND_LOG"
[ "\${FAKE_DUMP_FAIL:-0}" = 1 ] && exit 9
[ -n "\${FAKE_DUMP_SLEEP:-}" ] && sleep "$FAKE_DUMP_SLEEP"
printf '%s\n' 'CREATE TABLE restored(id INT);'
`);
  await writeExecutable(join(bin, 'date'), `#!/bin/sh
[ -n "\${FAKE_DATE:-}" ] && { printf '%s\n' "$FAKE_DATE"; exit 0; }
exec /usr/bin/date "$@"
`);
  await writeExecutable(join(bin, 'mysql'), `#!/bin/sh
printf 'mysql' >> "$FAKE_COMMAND_LOG"
for value in "$@"; do printf ' <%s>' "$value" >> "$FAKE_COMMAND_LOG"; done
printf '\n' >> "$FAKE_COMMAND_LOG"
case " $* " in
  *INFORMATION_SCHEMA.SCHEMATA*) [ "\${FAKE_SCHEMA_EXISTS:-0}" = 1 ] && printf '%s\n' existing ;;
  *'CREATE DATABASE'*) [ "\${FAKE_CREATE_FAIL_AFTER_SIDE_EFFECT:-0}" = 1 ] && exit 12 ;;
  *'DROP DATABASE'*) [ "\${FAKE_DROP_FAIL:-0}" = 1 ] && exit 13 ;;
esac
input="$(cat)"
if [ -n "$input" ]; then
  printf 'stdin <%s>\n' "$input" >> "$FAKE_COMMAND_LOG"
  if [ "\${FAKE_IMPORT_FAIL:-0}" = 1 ]; then
    exit 8
  fi
fi
exit 0
`);
  await writeExecutable(join(bin, 'gzip'), `#!/bin/sh
if [ "\${1:-}" = -t ]; then [ "\${FAKE_GZIP_TEST_FAIL:-0}" = 1 ] && exit 11; exit 0; fi
if [ "\${1:-}" = -dc ]; then
  if [ -n "\${FAKE_GZIP_OUTPUT_BYTES:-}" ]; then
    head -c "$FAKE_GZIP_OUTPUT_BYTES" /dev/zero | tr '\\000' x
  else
    cat "$2"
  fi
else
  cat
fi
`);
  await writeExecutable(join(bin, 'sha256sum'), `#!/bin/sh
if [ "\${1:-}" = -c ]; then
  [ "\${FAKE_CHECKSUM_FAIL:-0}" = 1 ] && exit 7
  [ -f "$2" ] || exit 6
  [ -n "\${FAKE_ORIGINAL_SQL_TO_SWAP:-}" ] && printf '%s\n' 'MALICIOUS SWAP' > "$FAKE_ORIGINAL_SQL_TO_SWAP"
  exit 0
fi
for value in "$@"; do
  name="\${value##*/}"
  printf '%064d  %s\n' 0 "$name"
done
`);
  await writeExecutable(join(bin, 'mv'), `#!/bin/sh
/usr/bin/mv "$@" || exit $?
case " $* " in
  *'.avatar-restore-'*) [ "\${FAKE_SIGNAL_AFTER_AVATAR_MOVE:-0}" = 1 ] && kill -TERM "$PPID" ;;
esac
exit 0
`);
  await writeExecutable(join(bin, 'rmdir'), `#!/bin/sh
target=''
for value in "$@"; do target="$value"; done
if [ -n "\${FAKE_INTRUDE_AVATAR_TARGET:-}" ] && [ "$target" = "$FAKE_INTRUDE_AVATAR_TARGET" ]; then
  printf '%s\n' external > "$target/external.txt"
fi
/usr/bin/rmdir "$@" || exit $?
if [ -n "\${FAKE_SIGNAL_AFTER_AVATAR_RMDIR:-}" ] && [ "$target" = "$FAKE_SIGNAL_AFTER_AVATAR_RMDIR" ]; then
  kill -TERM "$PPID"
fi
exit 0
`);
  await writeExecutable(join(bin, 'tar'), `#!/bin/sh
printf 'tar' >> "$FAKE_COMMAND_LOG"
for value in "$@"; do printf ' <%s>' "$value" >> "$FAKE_COMMAND_LOG"; done
printf '\n' >> "$FAKE_COMMAND_LOG"
case " $* " in
  *' -czf '*)
    previous=''
    archive=''
    directory='.'
    list=''
    for value in "$@"; do
      [ "$previous" = -C ] && directory="$value"
      [ "$previous" = -czf ] && archive="$value"
      [ "$previous" = --files-from ] && list="$value"
      case "$value" in --files-from=*) list="\${value#--files-from=}" ;; esac
      previous="$value"
    done
    printf '%s\n' avatar-archive > "$archive"
    if [ -n "\${FAKE_ARCHIVE_CAPTURE:-}" ]; then
      if [ -n "$list" ]; then
        cat "$list" > "$FAKE_ARCHIVE_CAPTURE"
      else
        source="\${!#}"
        (cd "$directory" && find "$source" -print | sort) > "$FAKE_ARCHIVE_CAPTURE"
      fi
    fi
    exit 0
    ;;
  *' -tzf '*)
    if [ -n "\${FAKE_TAR_LIST_FILE:-}" ]; then cat "$FAKE_TAR_LIST_FILE"; else
      printf '%s\n' avatars/ "avatars/${controlledAvatarName}"
    fi
    ;;
  *' -tvzf '*)
    if [ -n "\${FAKE_TAR_VERBOSE_FILE:-}" ]; then cat "$FAKE_TAR_VERBOSE_FILE"; else
      printf '%s\n' 'drwxr-xr-x root/root 0 now avatars/' '-rw-r--r-- root/root 15 now avatars/${controlledAvatarName}'
    fi
    ;;
  *' -xzf '*)
    previous=''
    destination=''
    for value in "$@"; do
      [ "$previous" = -C ] && destination="$value"
      previous="$value"
    done
    mkdir -p "$destination"
    printf '%s\n' restored-avatar > "$destination/cm123-01234567-89ab-4cde-8fab-0123456789ab.webp"
    ;;
esac
`);
  return { bin, log };
}

function commonEnvironment(
  fake: { bin: string; log: string },
  overrides: Record<string, string> = {}
): Record<string, string> {
  return {
    PATH: `${shellPath(fake.bin)}:/usr/bin:/bin`,
    FAKE_COMMAND_LOG: shellPath(fake.log),
    MYSQL_HOST: 'mysql.internal',
    MYSQL_PORT: '3306',
    MYSQL_USER: 'poker_backup',
    MYSQL_PASSWORD: 'do-not-log-this-password',
    NODE_BINARY: shellPath(process.execPath),
    RESTORE_INPUT_GUARD: shellPath(restoreInputGuard),
    ...overrides
  };
}

describe('backup and restore scripts', () => {
  let root: string;
  let fake: { bin: string; log: string };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'poker-backup-test-'));
    fake = await createFakeCommands(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('publishes a complete backup set and deletes only expired matching files', async () => {
    // Break caught: partial output is advertised or retention deletes unrelated operator files.
    const backupDir = join(root, 'backups');
    const avatarRoot = join(root, 'data', 'avatars');
    await mkdir(backupDir, { recursive: true });
    await mkdir(avatarRoot, { recursive: true });
    await writeFile(join(avatarRoot, 'player.webp'), 'avatar');
    const oldNames = [
      'mysql-20200101T000000Z.sql.gz',
      'avatars-20200101T000000Z.tar.gz',
      'manifest-20200101T000000Z.txt',
      'checksums-20200101T000000Z.txt'
    ];
    const oldDate = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000);
    for (const name of oldNames) {
      const path = join(backupDir, name);
      await writeFile(path, 'old');
      await utimes(path, oldDate, oldDate);
    }
    const unrelated = join(backupDir, 'operator-notes.txt');
    await writeFile(unrelated, 'keep me');
    await utimes(unrelated, oldDate, oldDate);

    const result = runScript(backupScript, commonEnvironment(fake, {
      BACKUP_DIR: shellPath(backupDir),
      AVATAR_ROOT: shellPath(avatarRoot),
      MYSQL_DATABASE: 'poker_scorekeeper'
    }));

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const files = await readdir(backupDir);
    const stamp = (await readFile(join(backupDir, 'latest-stamp'), 'utf8')).trim();
    expect(stamp).toMatch(/^\d{8}T\d{6}Z$/);
    expect(files).toEqual(expect.arrayContaining([
      `mysql-${stamp}.sql.gz`,
      `avatars-${stamp}.tar.gz`,
      `manifest-${stamp}.txt`,
      `checksums-${stamp}.txt`,
      'latest-stamp',
      'operator-notes.txt'
    ]));
    for (const name of oldNames) expect(files).not.toContain(name);
    expect(await readFile(unrelated, 'utf8')).toBe('keep me');
    const manifest = await readFile(join(backupDir, `manifest-${stamp}.txt`), 'utf8');
    expect(manifest).toContain('database=poker_scorekeeper');
    expect(manifest).not.toContain('do-not-log-this-password');
    const commandLog = await readFile(fake.log, 'utf8');
    expect(commandLog).toContain('mysqldump');
    expect(commandLog).toContain('<--single-transaction>');
    expect(commandLog).toContain('<--skip-add-locks>');
    expect(commandLog).not.toContain('do-not-log-this-password');
  });

  it('does not publish or advertise a failed database dump', async () => {
    // Break caught: a failed pipeline leaves a latest marker pointing at incomplete files.
    const backupDir = join(root, 'backups');
    const avatarRoot = join(root, 'data', 'avatars');
    await mkdir(backupDir, { recursive: true });
    await mkdir(avatarRoot, { recursive: true });

    const result = runScript(backupScript, commonEnvironment(fake, {
      BACKUP_DIR: shellPath(backupDir),
      AVATAR_ROOT: shellPath(avatarRoot),
      MYSQL_DATABASE: 'poker_scorekeeper',
      FAKE_DUMP_FAIL: '1'
    }));

    expect(result.status).not.toBe(0);
    expect(await readdir(backupDir)).toEqual([]);
  });

  it('serializes backups in one directory and a concurrent loser cannot remove the winner', async () => {
    // Break caught: same-second backup processes overwrite or delete each other's set/latest marker.
    const backupDir = join(root, 'backups');
    const avatarRoot = join(root, 'data', 'avatars');
    await mkdir(backupDir, { recursive: true });
    await mkdir(avatarRoot, { recursive: true });
    const environment = commonEnvironment(fake, {
      BACKUP_DIR: shellPath(backupDir),
      AVATAR_ROOT: shellPath(avatarRoot),
      MYSQL_DATABASE: 'poker_scorekeeper',
      FAKE_DATE: '20260818T111213Z',
      FAKE_DUMP_SLEEP: '1'
    });

    const winner = runScriptAsync(backupScript, environment);
    await waitForPath(join(backupDir, '.backup.lock'));
    const loser = runScript(backupScript, environment);
    const winnerResult = await winner;

    expect(loser.status).toBe(2);
    expect(winnerResult.status, winnerResult.stderr).toBe(0);
    expect((await readFile(join(backupDir, 'latest-stamp'), 'utf8')).trim())
      .toBe('20260818T111213Z');
    expect(await readdir(backupDir)).toEqual(expect.arrayContaining([
      'mysql-20260818T111213Z.sql.gz',
      'avatars-20260818T111213Z.tar.gz',
      'manifest-20260818T111213Z.txt',
      'checksums-20260818T111213Z.txt'
    ]));
  });

  it('never moves latest-stamp backwards when the clock regresses', async () => {
    // Break caught: a later process with an older wall clock hides the newest complete set.
    const backupDir = join(root, 'backups');
    const avatarRoot = join(root, 'data', 'avatars');
    await mkdir(backupDir, { recursive: true });
    await mkdir(avatarRoot, { recursive: true });
    const base = commonEnvironment(fake, {
      BACKUP_DIR: shellPath(backupDir),
      AVATAR_ROOT: shellPath(avatarRoot),
      MYSQL_DATABASE: 'poker_scorekeeper'
    });
    expect(runScript(backupScript, { ...base, FAKE_DATE: '20260818T121314Z' }).status).toBe(0);
    expect(runScript(backupScript, { ...base, FAKE_DATE: '20260818T111213Z' }).status).toBe(0);
    expect((await readFile(join(backupDir, 'latest-stamp'), 'utf8')).trim())
      .toBe('20260818T121314Z');
  });

  it('dumps the database first and archives only committed direct-child avatars', async () => {
    // Break caught: a backup captures upload temp files, symlinks, nested files, or avatars before DB snapshot.
    const backupDir = join(root, 'backups');
    const avatarRoot = join(root, 'data', 'avatars');
    const capture = join(root, 'archive-files.txt');
    await mkdir(backupDir, { recursive: true });
    await mkdir(join(avatarRoot, 'nested'), { recursive: true });
    const committed = 'cm123-01234567-89ab-4cde-8fab-0123456789ab.webp';
    await writeFile(join(avatarRoot, committed), 'committed');
    await writeFile(join(avatarRoot, `.${committed}.tmp`), 'partial');
    await writeFile(join(avatarRoot, 'operator.txt'), 'uncontrolled');
    await writeFile(join(avatarRoot, 'nested', committed), 'nested');
    await writeFile(join(avatarRoot, 'linked.webp'), 'uncontrolled-name');

    const result = runScript(backupScript, commonEnvironment(fake, {
      BACKUP_DIR: shellPath(backupDir),
      AVATAR_ROOT: shellPath(avatarRoot),
      MYSQL_DATABASE: 'poker_scorekeeper',
      FAKE_DATE: '20260818T131415Z',
      FAKE_ARCHIVE_CAPTURE: shellPath(capture)
    }));

    expect(result.status, result.stderr).toBe(0);
    expect((await readFile(capture, 'utf8')).trim().split(/\r?\n/)).toEqual([
      'avatars/',
      `avatars/${committed}`
    ]);
    const commands = (await readFile(fake.log, 'utf8')).trim().split(/\r?\n/);
    expect(commands[0]).toMatch(/^mysqldump/);
    expect(commands[1]).toMatch(/^tar/);
  });

  it('refuses an active-style production database name before invoking mysql', async () => {
    // Break caught: restore can overwrite the live poker_scorekeeper schema in place.
    const result = runScript(restoreScript, commonEnvironment(fake, {
      RESTORE_DATABASE: 'poker_scorekeeper',
      CONFIRM_RESTORE_DATABASE: 'poker_scorekeeper',
      CONFIRM_RESTORE_ACTION: 'RESTORE poker_scorekeeper'
    }));

    expect(result.status).toBe(2);
    await expect(stat(fake.log)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['checksum mismatch', { FAKE_CHECKSUM_FAIL: '1' }],
    ['checksum manifest with regex-lookalike filenames', {
      FAKE_CHECKSUM_CONTENT: [
        `${'0'.repeat(64)}  mysql-20260818T010203Z.sqlXgz`,
        `${'0'.repeat(64)}  avatars-20260818T010203Z.tarXgz`,
        `${'0'.repeat(64)}  manifest-20260818T010203ZXtxt`
      ].join('\n') + '\n'
    }],
    ['archive traversal', { ARCHIVE_FAULT: 'traversal' }],
    ['archive metacharacter path', { ARCHIVE_FAULT: 'metacharacter' }],
    ['archive symlink', { ARCHIVE_FAULT: 'symlink' }],
    ['damaged SQL gzip stream', { FAKE_GZIP_TEST_FAIL: '1' }],
    ['avatar entry count over configured limit', {
      RESTORE_MAX_AVATAR_ENTRIES: '1'
    }],
    ['single avatar over configured limit', { RESTORE_MAX_AVATAR_FILE_BYTES: '10' }],
    ['expanded avatar total over configured limit', { RESTORE_MAX_AVATAR_TOTAL_BYTES: '10' }],
    ['compressed avatar archive over configured limit', { RESTORE_MAX_AVATAR_ARCHIVE_BYTES: '1' }],
    ['compressed SQL archive over configured limit', { RESTORE_MAX_SQL_BYTES: '1' }],
    ['oversized manifest', { FAKE_MANIFEST_CONTENT: `format_version=1\n${'x'.repeat(70_000)}` }],
    ['oversized checksum file', { FAKE_CHECKSUM_CONTENT: `${'0'.repeat(70_000)}\n` }],
    ['restore limit over its hard maximum', { RESTORE_MAX_AVATAR_ENTRIES: '100001' }],
    ['unknown manifest field', { FAKE_MANIFEST_EXTRA: 'unexpected=value\n' }],
    ['duplicate manifest field', { FAKE_MANIFEST_EXTRA: 'stamp=20260818T010203Z\n' }]
  ])('rejects %s before creating a database', async (_name, fault) => {
    // Break caught: an untrusted or corrupt archive reaches mysql or the restore target.
    const bundle = await createRestoreBundle(root, fault);
    const target = join(root, 'restore-avatars');
    await mkdir(target);
    const result = runScript(restoreScript, commonEnvironment(fake, {
      ...bundle.environment,
      RESTORE_AVATAR_PARENT: shellPath(root),
      RESTORE_AVATAR_ROOT: shellPath(target),
      ...fault
    }));

    expect(result.status).toBe(2);
    if (_name.startsWith('oversized')) {
      expect(result.stderr).toContain('restore input exceeds configured limit');
    }
    const commandLog = await readFile(fake.log, 'utf8').catch(() => '');
    expect(commandLog.split('\n').some((line) => line.startsWith('mysql'))).toBe(false);
    expect(await readdir(target)).toEqual([]);
  });

  it('restores into a new isolated database and empty avatar directory without exposing password', async () => {
    // Break caught: validated restore data never reaches both targets or credentials enter argv.
    const bundle = await createRestoreBundle(root);
    const parent = join(root, 'restore');
    const target = join(parent, 'avatars');
    await mkdir(target, { recursive: true });
    const result = runScript(restoreScript, commonEnvironment(fake, {
      ...bundle.environment,
      RESTORE_AVATAR_PARENT: shellPath(parent),
      RESTORE_AVATAR_ROOT: shellPath(target)
    }));

    const diagnostics = await readFile(fake.log, 'utf8').catch(() => 'no command log');
    expect(result.status, `${result.stderr}\n${result.stdout}\n${diagnostics}`).toBe(0);
    expect(await readFile(
      join(target, 'cm123-01234567-89ab-4cde-8fab-0123456789ab.webp'),
      'utf8'
    )).toContain('restored-avatar');
    const commandLog = await readFile(fake.log, 'utf8');
    expect(commandLog).toContain('poker_scorekeeper_restore');
    expect(commandLog).toContain('CREATE DATABASE');
    expect(commandLog).not.toContain('do-not-log-this-password');
  });

  it('drops the newly created isolated schema and leaves avatars empty when import fails', async () => {
    // Break caught: a failed import leaves a half-restored schema or partially moved avatars.
    const bundle = await createRestoreBundle(root);
    const parent = join(root, 'restore');
    const target = join(parent, 'avatars');
    await mkdir(target, { recursive: true });
    const result = runScript(restoreScript, commonEnvironment(fake, {
      ...bundle.environment,
      RESTORE_AVATAR_PARENT: shellPath(parent),
      RESTORE_AVATAR_ROOT: shellPath(target),
      FAKE_IMPORT_FAIL: '1'
    }));

    expect(result.status).not.toBe(0);
    expect(await readdir(target)).toEqual([]);
    expect(await readFile(fake.log, 'utf8')).toContain('DROP DATABASE');
  });

  it('does not drop a database when CREATE loses an existence race', async () => {
    // Break caught: a failed CREATE is treated as owned and cleanup drops another actor's new schema.
    const bundle = await createRestoreBundle(root);
    const parent = join(root, 'restore');
    const target = join(parent, 'avatars');
    await mkdir(target, { recursive: true });
    const result = runScript(restoreScript, commonEnvironment(fake, {
      ...bundle.environment,
      RESTORE_AVATAR_PARENT: shellPath(parent),
      RESTORE_AVATAR_ROOT: shellPath(target),
      FAKE_CREATE_FAIL_AFTER_SIDE_EFFECT: '1'
    }));

    expect(result.status).not.toBe(0);
    expect(await readFile(fake.log, 'utf8')).not.toContain('DROP DATABASE');
    expect(await readdir(target)).toEqual([]);
  });

  it('does not delete external avatar content written after the empty check', async () => {
    // Break caught: publication rmdir fails after an external writer arrives, then cleanup rm -rf deletes it.
    const bundle = await createRestoreBundle(root);
    const parent = join(root, 'restore');
    const target = join(parent, 'avatars');
    await mkdir(target, { recursive: true });
    const result = runScript(restoreScript, commonEnvironment(fake, {
      ...bundle.environment,
      RESTORE_AVATAR_PARENT: shellPath(parent),
      RESTORE_AVATAR_ROOT: shellPath(target),
      FAKE_INTRUDE_AVATAR_TARGET: shellPath(target)
    }));

    expect(result.status).not.toBe(0);
    expect(await readFile(join(target, 'external.txt'), 'utf8')).toContain('external');
    expect(await readFile(fake.log, 'utf8')).toContain('DROP DATABASE');
  });

  it('recreates an empty target when terminated immediately after removing it', async () => {
    // Break caught: TERM after rmdir but before mv leaves the configured restore mount target absent.
    const bundle = await createRestoreBundle(root);
    const parent = join(root, 'restore');
    const target = join(parent, 'avatars');
    await mkdir(target, { recursive: true });
    const result = runScript(restoreScript, commonEnvironment(fake, {
      ...bundle.environment,
      RESTORE_AVATAR_PARENT: shellPath(parent),
      RESTORE_AVATAR_ROOT: shellPath(target),
      FAKE_SIGNAL_AFTER_AVATAR_RMDIR: shellPath(target)
    }));

    expect(result.status).toBe(143);
    expect(await readdir(target)).toEqual([]);
    expect(await readFile(fake.log, 'utf8')).toContain('DROP DATABASE');
  });

  it('reports a controlled cleanup warning when the temporary account cannot drop the new schema', async () => {
    // Break caught: cleanup privilege errors leak a credential or falsely imply rollback succeeded.
    const bundle = await createRestoreBundle(root);
    const parent = join(root, 'restore');
    const target = join(parent, 'avatars');
    await mkdir(target, { recursive: true });
    const result = runScript(restoreScript, commonEnvironment(fake, {
      ...bundle.environment,
      RESTORE_AVATAR_PARENT: shellPath(parent),
      RESTORE_AVATAR_ROOT: shellPath(target),
      FAKE_IMPORT_FAIL: '1',
      FAKE_DROP_FAIL: '1'
    }));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('restore cleanup failed: new database could not be dropped');
    expect(result.stderr).not.toContain('do-not-log-this-password');
  });

  it('uses private snapshots when an input is swapped after initial validation', async () => {
    // Break caught: checksum validation and import open the attacker-replaced original path twice.
    const bundle = await createRestoreBundle(root);
    const parent = join(root, 'restore');
    const target = join(parent, 'avatars');
    await mkdir(target, { recursive: true });
    const result = runScript(restoreScript, commonEnvironment(fake, {
      ...bundle.environment,
      RESTORE_AVATAR_PARENT: shellPath(parent),
      RESTORE_AVATAR_ROOT: shellPath(target),
      FAKE_ORIGINAL_SQL_TO_SWAP: bundle.environment.SQL_ARCHIVE!
    }));

    expect(result.status, result.stderr).toBe(0);
    const log = await readFile(fake.log, 'utf8');
    expect(log).toContain('CREATE TABLE restored');
    expect(log).not.toContain('MALICIOUS SWAP');
  });

  it('removes the newly created database and published avatar tree when terminated after move', async () => {
    // Break caught: TERM between avatar publication and success leaves half-restored state.
    const bundle = await createRestoreBundle(root);
    const parent = join(root, 'restore');
    const target = join(parent, 'avatars');
    await mkdir(target, { recursive: true });
    const result = runScript(restoreScript, commonEnvironment(fake, {
      ...bundle.environment,
      RESTORE_AVATAR_PARENT: shellPath(parent),
      RESTORE_AVATAR_ROOT: shellPath(target),
      FAKE_SIGNAL_AFTER_AVATAR_MOVE: '1'
    }));

    expect(result.status).toBe(143);
    expect(await readdir(target)).toEqual([]);
    expect(await readFile(fake.log, 'utf8')).toContain('DROP DATABASE');
  });

  it('drops the owned database when decompressed SQL exceeds its streaming limit', async () => {
    // Break caught: a tiny gzip expands without bound into mysql and leaves a partial restore schema.
    const bundle = await createRestoreBundle(root);
    const parent = join(root, 'restore');
    const target = join(parent, 'avatars');
    await mkdir(target, { recursive: true });
    const result = runScript(restoreScript, commonEnvironment(fake, {
      ...bundle.environment,
      RESTORE_AVATAR_PARENT: shellPath(parent),
      RESTORE_AVATAR_ROOT: shellPath(target),
      RESTORE_MAX_SQL_EXPANDED_BYTES: '10',
      FAKE_GZIP_OUTPUT_BYTES: '11'
    }));

    expect(result.status).not.toBe(0);
    const commands = await readFile(fake.log, 'utf8');
    expect(commands).toContain('CREATE DATABASE');
    expect(commands).toContain('DROP DATABASE');
    expect(await readdir(target)).toEqual([]);
  });
});

async function createRestoreBundle(
  root: string,
  fault: Record<string, string> = {}
): Promise<{ environment: Record<string, string> }> {
  const bundle = join(root, `bundle-${Math.random().toString(16).slice(2)}`);
  await mkdir(bundle);
  const stamp = '20260818T010203Z';
  const sql = join(bundle, `mysql-${stamp}.sql.gz`);
  const avatars = join(bundle, `avatars-${stamp}.tar.gz`);
  const manifest = join(bundle, `manifest-${stamp}.txt`);
  const checksums = join(bundle, `checksums-${stamp}.txt`);
  await writeFile(sql, 'CREATE TABLE restored(id INT);');
  const archiveEntries: RestoreTarEntry[] = [{ name: 'avatars/', type: '5' }];
  if (fault.ARCHIVE_FAULT === 'traversal') {
    archiveEntries.push({ name: 'avatars/../../escape', contents: Buffer.from('escape') });
  } else if (fault.ARCHIVE_FAULT === 'metacharacter') {
    archiveEntries.push({ name: 'avatars/unsafe]name.webp', contents: Buffer.from('unsafe') });
  } else if (fault.ARCHIVE_FAULT === 'symlink') {
    archiveEntries.push({ name: `avatars/${controlledAvatarName}`, type: '2' });
  } else {
    archiveEntries.push({
      name: `avatars/${controlledAvatarName}`,
      contents: Buffer.from('restored-avatar')
    });
  }
  await writeFile(avatars, restoreTarArchive(archiveEntries));
  await writeFile(
    manifest,
    fault.FAKE_MANIFEST_CONTENT ??
      `format_version=1\nstamp=${stamp}\ndatabase=poker_scorekeeper\navatar_directory=avatars\n${fault.FAKE_MANIFEST_EXTRA ?? ''}`
  );
  await writeFile(
    checksums,
    fault.FAKE_CHECKSUM_CONTENT ?? [
      `${'0'.repeat(64)}  mysql-${stamp}.sql.gz`,
      `${'0'.repeat(64)}  avatars-${stamp}.tar.gz`,
      `${'0'.repeat(64)}  manifest-${stamp}.txt`
    ].join('\n') + '\n'
  );
  return {
    environment: {
      RESTORE_DATABASE: 'poker_scorekeeper_restore',
      CONFIRM_RESTORE_DATABASE: 'poker_scorekeeper_restore',
      CONFIRM_RESTORE_ACTION: 'RESTORE poker_scorekeeper_restore',
      SQL_ARCHIVE: shellPath(sql),
      AVATAR_ARCHIVE: shellPath(avatars),
      MANIFEST_FILE: shellPath(manifest),
      CHECKSUM_FILE: shellPath(checksums)
    }
  };
}
