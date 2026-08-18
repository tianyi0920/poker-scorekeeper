import { spawnSync } from 'node:child_process';
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

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const backupScript = join(repositoryRoot, 'scripts', 'backup', 'backup.sh');
const restoreScript = join(repositoryRoot, 'scripts', 'backup', 'restore.sh');
const bash = process.env.BASH_PATH ?? 'bash';

function shellPath(path: string): string {
  if (process.platform !== 'win32') return path;
  return path.replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`)
    .replaceAll('\\', '/');
}

function runScript(script: string, env: Record<string, string>) {
  return spawnSync(bash, env.DEBUG_SHELL === '1' ? ['-x', shellPath(script)] : [shellPath(script)], {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
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
printf '%s\n' 'CREATE TABLE restored(id INT);'
`);
  await writeExecutable(join(bin, 'mysql'), `#!/bin/sh
printf 'mysql' >> "$FAKE_COMMAND_LOG"
for value in "$@"; do printf ' <%s>' "$value" >> "$FAKE_COMMAND_LOG"; done
printf '\n' >> "$FAKE_COMMAND_LOG"
case " $* " in
  *INFORMATION_SCHEMA.SCHEMATA*) [ "\${FAKE_SCHEMA_EXISTS:-0}" = 1 ] && printf '%s\n' existing ;;
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
if [ "\${1:-}" = -dc ]; then cat "$2"; else cat; fi
`);
  await writeExecutable(join(bin, 'sha256sum'), `#!/bin/sh
if [ "\${1:-}" = -c ]; then
  [ "\${FAKE_CHECKSUM_FAIL:-0}" = 1 ] && exit 7
  [ -f "$2" ] || exit 6
  exit 0
fi
for value in "$@"; do
  name="\${value##*/}"
  printf '%064d  %s\n' 0 "$name"
done
`);
  await writeExecutable(join(bin, 'tar'), `#!/bin/sh
printf 'tar' >> "$FAKE_COMMAND_LOG"
for value in "$@"; do printf ' <%s>' "$value" >> "$FAKE_COMMAND_LOG"; done
printf '\n' >> "$FAKE_COMMAND_LOG"
case " $* " in
  *' -czf '*)
    previous=''
    for value in "$@"; do
      if [ "$previous" = -czf ]; then printf '%s\n' avatar-archive > "$value"; exit 0; fi
      previous="$value"
    done
    ;;
  *' -tzf '*) cat "$FAKE_TAR_LIST_FILE" ;;
  *' -tvzf '*) cat "$FAKE_TAR_VERBOSE_FILE" ;;
  *' -xzf '*)
    previous=''
    destination=''
    for value in "$@"; do
      [ "$previous" = -C ] && destination="$value"
      previous="$value"
    done
    mkdir -p "$destination"
    printf '%s\n' restored-avatar > "$destination/restored.webp"
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
    ['archive traversal', { FAKE_TAR_LIST: 'avatars/\navatars/../../escape\n' }],
    ['archive symlink', { FAKE_TAR_VERBOSE: 'drwxr-xr-x root/root 0 now avatars/\nlrwxrwxrwx root/root 0 now avatars/link -> /etc\n' }]
  ])('rejects %s before creating a database', async (_name, fault) => {
    // Break caught: an untrusted or corrupt archive reaches mysql or the restore target.
    const bundle = await createRestoreBundle(root, fault);
    const target = join(root, 'restore-avatars');
    await mkdir(target);
    const result = runScript(restoreScript, commonEnvironment(fake, {
      ...bundle.environment,
      RESTORE_AVATAR_ROOT: shellPath(target),
      ...fault
    }));

    expect(result.status).toBe(2);
    const commandLog = await readFile(fake.log, 'utf8').catch(() => '');
    expect(commandLog.split('\n').some((line) => line.startsWith('mysql'))).toBe(false);
    expect(await readdir(target)).toEqual([]);
  });

  it('restores into a new isolated database and empty avatar directory without exposing password', async () => {
    // Break caught: validated restore data never reaches both targets or credentials enter argv.
    const bundle = await createRestoreBundle(root);
    const target = join(root, 'restore-avatars');
    await mkdir(target);
    const result = runScript(restoreScript, commonEnvironment(fake, {
      ...bundle.environment,
      RESTORE_AVATAR_ROOT: shellPath(target)
    }));

    const diagnostics = await readFile(fake.log, 'utf8').catch(() => 'no command log');
    expect(result.status, `${result.stderr}\n${result.stdout}\n${diagnostics}`).toBe(0);
    expect(await readFile(join(target, 'restored.webp'), 'utf8')).toContain('restored-avatar');
    const commandLog = await readFile(fake.log, 'utf8');
    expect(commandLog).toContain('poker_scorekeeper_restore');
    expect(commandLog).toContain('CREATE DATABASE');
    expect(commandLog).not.toContain('do-not-log-this-password');
  });

  it('drops the newly created isolated schema and leaves avatars empty when import fails', async () => {
    // Break caught: a failed import leaves a half-restored schema or partially moved avatars.
    const bundle = await createRestoreBundle(root);
    const target = join(root, 'restore-avatars');
    await mkdir(target);
    const result = runScript(restoreScript, commonEnvironment(fake, {
      ...bundle.environment,
      RESTORE_AVATAR_ROOT: shellPath(target),
      FAKE_IMPORT_FAIL: '1'
    }));

    expect(result.status).not.toBe(0);
    expect(await readdir(target)).toEqual([]);
    expect(await readFile(fake.log, 'utf8')).toContain('DROP DATABASE');
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
  const list = join(bundle, 'tar-list.txt');
  const verbose = join(bundle, 'tar-verbose.txt');
  await writeFile(sql, 'CREATE TABLE restored(id INT);');
  await writeFile(avatars, 'avatar-archive');
  await writeFile(manifest, `stamp=${stamp}\ndatabase=poker_scorekeeper\n`);
  await writeFile(
    checksums,
    fault.FAKE_CHECKSUM_CONTENT ?? [
      `${'0'.repeat(64)}  mysql-${stamp}.sql.gz`,
      `${'0'.repeat(64)}  avatars-${stamp}.tar.gz`,
      `${'0'.repeat(64)}  manifest-${stamp}.txt`
    ].join('\n') + '\n'
  );
  await writeFile(list, fault.FAKE_TAR_LIST ?? 'avatars/\navatars/restored.webp\n');
  await writeFile(
    verbose,
    fault.FAKE_TAR_VERBOSE ?? '-rw-r--r-- root/root 15 now avatars/restored.webp\n'
  );
  return {
    environment: {
      RESTORE_DATABASE: 'poker_scorekeeper_restore',
      CONFIRM_RESTORE_DATABASE: 'poker_scorekeeper_restore',
      CONFIRM_RESTORE_ACTION: 'RESTORE poker_scorekeeper_restore',
      SQL_ARCHIVE: shellPath(sql),
      AVATAR_ARCHIVE: shellPath(avatars),
      MANIFEST_FILE: shellPath(manifest),
      CHECKSUM_FILE: shellPath(checksums),
      FAKE_TAR_LIST_FILE: shellPath(list),
      FAKE_TAR_VERBOSE_FILE: shellPath(verbose)
    }
  };
}
