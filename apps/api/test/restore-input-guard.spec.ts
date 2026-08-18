import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  copyOpenRegularFile,
  snapshotRegularFile,
  validateAvatarArchive
} from '../../../scripts/backup/restore-input-guard.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const guardScript = join(repositoryRoot, 'scripts', 'backup', 'restore-input-guard.mjs');
const avatarName = 'cm123-123e4567-e89b-42d3-a456-426614174000.webp';

interface TarEntry {
  name: string;
  type?: string;
  contents?: Buffer;
  declaredSize?: number;
}

function octal(value: number, width: number): Buffer {
  return Buffer.from(value.toString(8).padStart(width - 1, '0') + '\0', 'ascii');
}

function tarArchive(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const contents = entry.contents ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    octal(entry.type === '5' ? 0o755 : 0o644, 8).copy(header, 100);
    octal(0, 8).copy(header, 108);
    octal(0, 8).copy(header, 116);
    octal(entry.declaredSize ?? contents.length, 12).copy(header, 124);
    octal(0, 12).copy(header, 136);
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? '0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = [...header].reduce((sum, value) => sum + value, 0);
    Buffer.from(checksum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(header, 148);
    blocks.push(header, contents);
    const padding = (512 - (contents.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  const logicalArchive = Buffer.concat(blocks);
  const portableRecord = Buffer.concat([
    logicalArchive,
    Buffer.alloc(Math.max(0, (20 * 512) - logicalArchive.byteLength))
  ]);
  return gzipSync(portableRecord);
}

const defaultLimits = {
  maxEntries: 10,
  maxFileBytes: 1024,
  maxTotalBytes: 4096,
  maxPathBytes: 160
};

describe('restore input guard', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'poker-restore-guard-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('snapshots through one non-following descriptor and rejects links and devices', async () => {
    // Break caught: restore validates a path, then copies a swapped link/device/FIFO.
    const source = join(root, 'source-directory');
    const link = join(root, 'source-link');
    const destination = join(root, 'snapshot.txt');
    await mkdir(source);
    await symlink(source, link, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(snapshotRegularFile(link, destination, 1024)).rejects.toThrow();
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });

    const devicePath = process.platform === 'win32' ? '\\\\.\\NUL' : '/dev/null';
    await expect(snapshotRegularFile(devicePath, destination, 1024)).rejects.toThrow();
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a FIFO descriptor before attempting to read it', async () => {
    // Break caught: a FIFO passes a path-only check and blocks snapshotting.
    let readAttempted = false;
    const writes: Buffer[] = [];
    const destination = {
      async write(buffer: Buffer) { writes.push(Buffer.from(buffer)); },
      async sync() { return undefined; }
    };
    const specialSource = {
      async stat() { return { isFile: () => false, size: 0 }; },
      readable(): never {
        readAttempted = true;
        throw new Error('must not read a special file');
      }
    };
    await expect(copyOpenRegularFile(specialSource, destination, 3)).rejects
      .toThrow('regular file');
    expect(readAttempted).toBe(false);
  });

  it('rejects file growth beyond the cap while streaming', async () => {
    // Break caught: an appending regular file fills the restore volume after its initial stat.
    const writes: Buffer[] = [];
    const destination = {
      async write(buffer: Buffer) { writes.push(Buffer.from(buffer)); },
      async sync() { return undefined; }
    };
    const growingSource = {
      async stat() { return { isFile: () => true, size: 2 }; },
      async *readable() {
        yield Buffer.from('ab');
        yield Buffer.from('cd');
      }
    };
    await expect(copyOpenRegularFile(growingSource, destination, 3)).rejects
      .toThrow('configured limit');
    expect(Buffer.concat(writes).byteLength).toBeLessThanOrEqual(3);
  });

  it('streams a bounded tar and rejects links, counts, paths, and size limits', async () => {
    // Break caught: full untrusted tar listings are materialized or unsafe headers pass validation.
    const cases: Array<[string, TarEntry[], Partial<typeof defaultLimits>]> = [
      ['link', [
        { name: 'avatars/', type: '5' },
        { name: `avatars/${avatarName}`, type: '2' }
      ], {}],
      ['entry count', [
        { name: 'avatars/', type: '5' },
        { name: `avatars/${avatarName}`, contents: Buffer.from('a') }
      ], { maxEntries: 1 }],
      ['long path', [
        { name: 'avatars/', type: '5' },
        { name: `avatars/${avatarName}`, contents: Buffer.from('a') }
      ], { maxPathBytes: 20 }],
      ['single file', [
        { name: 'avatars/', type: '5' },
        { name: `avatars/${avatarName}`, contents: Buffer.from('abcd') }
      ], { maxFileBytes: 3 }],
      ['total files', [
        { name: 'avatars/', type: '5' },
        { name: `avatars/${avatarName}`, contents: Buffer.from('abcd') }
      ], { maxTotalBytes: 3 }]
    ];

    for (const [label, entries, limits] of cases) {
      const archive = join(root, `${label.replaceAll(' ', '-')}.tar.gz`);
      await writeFile(archive, tarArchive(entries));
      await expect(validateAvatarArchive(archive, { ...defaultLimits, ...limits }), label)
        .rejects.toThrow();
    }
  });

  it('accepts an archive emitted by the host tar without writing a listing file', async () => {
    // Break caught: the parser accepts only handcrafted fixtures, not a real tar producer's USTAR output.
    const tarBinary = process.platform === 'win32' ? 'tar.exe' : 'tar';
    const avatars = join(root, 'avatars');
    const archive = join(root, 'avatars.tar.gz');
    await mkdir(avatars);
    await writeFile(join(avatars, avatarName), 'real-avatar');
    const result = spawnSync(tarBinary, ['-C', root, '-czf', archive, 'avatars'], {
      encoding: 'utf8'
    });
    expect(result.status, result.stderr).toBe(0);

    await expect(validateAvatarArchive(archive, defaultLimits)).resolves.toEqual({
      entries: 2,
      files: 1,
      totalBytes: 11
    });

    await expect(validateAvatarArchive(archive, {
      maxEntries: 2,
      maxFileBytes: 11,
      maxTotalBytes: 11,
      maxPathBytes: 160
    })).resolves.toEqual({
      entries: 2,
      files: 1,
      totalBytes: 11
    });
  });

  it('accepts a portable 20-block tar record at exact logical limits', async () => {
    // Break caught: the envelope budgets payload but rejects standard 10 KiB tar record padding.
    const archive = join(root, 'portable-record.tar.gz');
    await writeFile(archive, tarArchive([
      { name: 'avatars/', type: '5' },
      { name: `avatars/${avatarName}`, contents: Buffer.from('real-avatar') }
    ]));

    await expect(validateAvatarArchive(archive, {
      maxEntries: 2,
      maxFileBytes: 11,
      maxTotalBytes: 11,
      maxPathBytes: 160
    })).resolves.toEqual({
      entries: 2,
      files: 1,
      totalBytes: 11
    });
  });

  it('limits decompressed SQL bytes before they reach mysql', () => {
    // Break caught: a small gzip expands without bound into the database importer.
    const result = spawnSync(process.execPath, [guardScript, 'limit-stream', '3'], {
      input: Buffer.from('four'),
      encoding: 'utf8'
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('stream exceeds configured limit');
    expect(result.stdout).toBe('');
  });
});
