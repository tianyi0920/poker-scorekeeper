#!/usr/bin/env node
import { constants, createReadStream } from 'node:fs';
import { lstat, open, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createGunzip } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const CONTROLLED_AVATAR = /^avatars\/[a-z0-9]{3,30}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/;

class RestoreInputError extends Error {}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RestoreInputError(`invalid ${name}`);
  }
  return parsed;
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset);
    if (bytesWritten < 1) throw new RestoreInputError('snapshot write failed');
    offset += bytesWritten;
  }
}

export async function copyOpenRegularFile(source, destination, maximumBytes) {
  const cap = positiveInteger(maximumBytes, 'snapshot limit');
  const before = await source.stat();
  if (!before.isFile()) throw new RestoreInputError('restore input must be a regular file');
  if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > cap) {
    throw new RestoreInputError('restore input exceeds configured limit');
  }

  let copied = 0;
  for await (const value of source.readable()) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    copied += chunk.byteLength;
    if (copied > cap) throw new RestoreInputError('restore input exceeds configured limit');
    await destination.write(chunk);
  }
  const after = await source.stat();
  if (!after.isFile() || after.size !== copied) {
    throw new RestoreInputError('restore input changed while snapshotting');
  }
  await destination.sync();
  return copied;
}

export async function snapshotRegularFile(sourcePath, destinationPath, maximumBytes) {
  let source;
  let destination;
  try {
    const sourceMetadata = await lstat(sourcePath);
    if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
      throw new RestoreInputError('restore input must be a regular non-symlink file');
    }
    const noFollow = constants.O_NOFOLLOW ?? 0;
    source = await open(sourcePath, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
    destination = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600
    );
    return await copyOpenRegularFile(
      {
        stat: () => source.stat(),
        readable: () => source.createReadStream({ autoClose: false })
      },
      {
        write: (buffer) => writeAll(destination, buffer),
        sync: () => destination.sync()
      },
      maximumBytes
    );
  } catch (error) {
    await rm(destinationPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await destination?.close().catch(() => undefined);
    await source?.close().catch(() => undefined);
  }
}

function tarString(header, start, length) {
  const field = header.subarray(start, start + length);
  const zero = field.indexOf(0);
  return field.subarray(0, zero === -1 ? field.length : zero).toString('utf8');
}

function tarOctal(header, start, length, label) {
  const field = header.subarray(start, start + length).toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(field)) throw new RestoreInputError(`invalid tar ${label}`);
  const value = Number.parseInt(field, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new RestoreInputError(`invalid tar ${label}`);
  return value;
}

function verifyTarChecksum(header) {
  const expected = tarOctal(header, 148, 8, 'checksum');
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) throw new RestoreInputError('invalid tar checksum');
}

class BoundedStreamReader {
  constructor(stream, maximumBytes) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.maximumBytes = maximumBytes;
    this.buffer = Buffer.alloc(0);
    this.ended = false;
    this.consumed = 0;
  }

  async fill() {
    if (this.buffer.byteLength > 0 || this.ended) return;
    const result = await this.iterator.next();
    if (result.done) {
      this.ended = true;
      return;
    }
    this.buffer = Buffer.isBuffer(result.value) ? result.value : Buffer.from(result.value);
  }

  account(length) {
    this.consumed += length;
    if (this.consumed > this.maximumBytes) {
      throw new RestoreInputError('avatar archive expands beyond safe envelope');
    }
  }

  async exact(length) {
    const parts = [];
    let remaining = length;
    while (remaining > 0) {
      await this.fill();
      if (this.ended) throw new RestoreInputError('truncated avatar archive');
      const take = Math.min(remaining, this.buffer.byteLength);
      parts.push(this.buffer.subarray(0, take));
      this.buffer = this.buffer.subarray(take);
      this.account(take);
      remaining -= take;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
  }

  async skip(length) {
    let remaining = length;
    while (remaining > 0) {
      await this.fill();
      if (this.ended) throw new RestoreInputError('truncated avatar archive');
      const take = Math.min(remaining, this.buffer.byteLength);
      this.buffer = this.buffer.subarray(take);
      this.account(take);
      remaining -= take;
    }
  }

  async drainZeros() {
    while (true) {
      await this.fill();
      if (this.ended) return;
      if (this.buffer.some((value) => value !== 0)) {
        throw new RestoreInputError('unexpected data after tar terminator');
      }
      this.account(this.buffer.byteLength);
      this.buffer = Buffer.alloc(0);
    }
  }
}

export async function validateAvatarArchive(archivePath, limits) {
  const maxEntries = positiveInteger(limits.maxEntries, 'avatar entry limit');
  const maxFileBytes = positiveInteger(limits.maxFileBytes, 'avatar file limit');
  const maxTotalBytes = positiveInteger(limits.maxTotalBytes, 'avatar total limit');
  const maxPathBytes = positiveInteger(limits.maxPathBytes, 'avatar path limit');
  // One entry can consume a 512-byte header plus up to 511 bytes of padding.
  // A conforming producer may then pad the archive to a 20-block (10 KiB) record.
  const maximumTarBytes = maxTotalBytes + (maxEntries * 1024) + (20 * 512);
  if (!Number.isSafeInteger(maximumTarBytes)) throw new RestoreInputError('invalid avatar limits');

  const gunzip = createReadStream(archivePath).pipe(createGunzip());
  const reader = new BoundedStreamReader(gunzip, maximumTarBytes);
  const names = new Set();
  let entries = 0;
  let files = 0;
  let rootEntries = 0;
  let totalBytes = 0;
  let zeroBlocks = 0;

  while (zeroBlocks < 2) {
    const header = await reader.exact(512);
    if (header.every((value) => value === 0)) {
      zeroBlocks += 1;
      continue;
    }
    if (zeroBlocks !== 0) throw new RestoreInputError('invalid tar terminator');
    verifyTarChecksum(header);
    entries += 1;
    if (entries > maxEntries) throw new RestoreInputError('avatar archive has too many entries');

    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (
      path === '' ||
      Buffer.byteLength(path, 'utf8') > maxPathBytes ||
      path.startsWith('/') ||
      path.includes('\\') ||
      path.split('/').includes('..') ||
      names.has(path)
    ) {
      throw new RestoreInputError('unsafe avatar archive path');
    }
    names.add(path);

    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const size = tarOctal(header, 124, 12, 'size');
    if (type === '5') {
      if ((path !== 'avatars' && path !== 'avatars/') || size !== 0) {
        throw new RestoreInputError('invalid avatar root entry');
      }
      rootEntries += 1;
    } else if (type === '0') {
      if (!CONTROLLED_AVATAR.test(path)) {
        throw new RestoreInputError('avatar archive contains an uncontrolled filename');
      }
      if (size > maxFileBytes) throw new RestoreInputError('avatar file exceeds configured limit');
      totalBytes += size;
      if (totalBytes > maxTotalBytes) {
        throw new RestoreInputError('avatar archive expands beyond configured limit');
      }
      files += 1;
    } else {
      throw new RestoreInputError('avatar archive contains links or special files');
    }
    await reader.skip(size);
    await reader.skip((512 - (size % 512)) % 512);
  }
  await reader.drainZeros();
  if (rootEntries !== 1) throw new RestoreInputError('avatar archive must contain one root directory');
  return { entries, files, totalBytes };
}

async function limitStream(maximumBytes) {
  const cap = positiveInteger(maximumBytes, 'stream limit');
  let total = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.byteLength;
    if (total > cap) throw new RestoreInputError('stream exceeds configured limit');
    if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
  }
}

async function main(arguments_) {
  const [command, ...values] = arguments_;
  if (command === 'snapshot' && values.length === 3) {
    await snapshotRegularFile(values[0], values[1], positiveInteger(values[2], 'snapshot limit'));
    return;
  }
  if (command === 'validate-avatar-tar' && values.length === 5) {
    const result = await validateAvatarArchive(values[0], {
      maxEntries: positiveInteger(values[1], 'avatar entry limit'),
      maxFileBytes: positiveInteger(values[2], 'avatar file limit'),
      maxTotalBytes: positiveInteger(values[3], 'avatar total limit'),
      maxPathBytes: positiveInteger(values[4], 'avatar path limit')
    });
    process.stdout.write(`${result.files}\n`);
    return;
  }
  if (command === 'limit-stream' && values.length === 1) {
    await limitStream(values[0]);
    return;
  }
  throw new RestoreInputError('invalid restore input guard command');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof RestoreInputError
      ? error.message
      : 'restore input validation failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  });
}
