import { constants } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { createStaticAssetsHandler, readControlledUploadedAvatar } from './static.module.js';

describe('uploaded avatar file descriptor safety', () => {
  it('reads and validates through the same no-follow file descriptor', async () => {
    // Break caught: path is checked, swapped to a symlink, and reopened for the actual read.
    const close = vi.fn(async () => undefined);
    let flags = 0;
    const contents = await readControlledUploadedAvatar(
      '/controlled/avatar-root',
      'cm123-123e4567-e89b-42d3-a456-426614174000.webp',
      async (_path, openFlags) => {
        flags = openFlags;
        return {
          stat: vi.fn(async () => ({ isFile: () => true, size: 15 })),
          readFile: vi.fn(async () => Buffer.from('committed-avatar')),
          close
        };
      }
    );

    expect(contents?.toString()).toBe('committed-avatar');
    if (constants.O_NOFOLLOW !== undefined) {
      expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    } else {
      // Windows does not expose O_NOFOLLOW; the production Linux image does.
      expect(flags & constants.O_RDONLY).toBe(constants.O_RDONLY);
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects oversized or non-regular descriptor targets and always closes them', async () => {
    // Break caught: an uncontrolled large/special file is buffered into the API process.
    const close = vi.fn(async () => undefined);
    const contents = await readControlledUploadedAvatar(
      '/controlled/avatar-root',
      'cm123-123e4567-e89b-42d3-a456-426614174000.webp',
      async () => ({
        stat: vi.fn(async () => ({ isFile: () => true, size: 5 * 1024 * 1024 + 1 })),
        readFile: vi.fn(async () => Buffer.from('must-not-read')),
        close
      })
    );
    expect(contents).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it.runIf(constants.O_NOFOLLOW !== undefined)(
    'refuses a real symlink at the final controlled filename',
    async () => {
      // Break caught: Linux follows an avatar symlink outside the persistent upload root.
      const root = await mkdtemp(join(tmpdir(), 'poker-static-avatar-'));
      try {
        const outside = join(root, 'outside');
        const avatarRoot = join(root, 'avatars');
        await mkdir(avatarRoot);
        await writeFile(outside, 'outside');
        const filename = 'cm123-123e4567-e89b-42d3-a456-426614174000.webp';
        await symlink(outside, join(avatarRoot, filename));
        await expect(readControlledUploadedAvatar(avatarRoot, filename)).rejects.toMatchObject({
          code: expect.stringMatching(/ELOOP|EMLINK/)
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});

describe('preset avatar static assets', () => {
  it('serves the new selectable preset files while retaining the legacy URL space', async () => {
    // Break caught: the API advertises a selectable preset that static middleware rejects as reserved.
    const webRoot = await mkdtemp(join(tmpdir(), 'poker-static-presets-'));
    try {
      const avatars = join(webRoot, 'avatars');
      await mkdir(avatars);
      const newPreset = Buffer.from('new-preset');
      const legacyPreset = Buffer.from('legacy-preset');
      await writeFile(join(avatars, 'preset-13.webp'), newPreset);
      await writeFile(join(avatars, 'preset-01.webp'), legacyPreset);
      const app = express();
      app.use(createStaticAssetsHandler({ WEB_DIST_ROOT: webRoot }));
      app.use((_request, response) => response.sendStatus(404));

      const newResponse = await request(app).get('/avatars/preset-13.webp').expect(200);
      const legacyResponse = await request(app).get('/avatars/preset-01.webp').expect(200);
      expect(newResponse.body).toEqual(newPreset);
      expect(legacyResponse.body).toEqual(legacyPreset);
    } finally {
      await rm(webRoot, { recursive: true, force: true });
    }
  });
});
