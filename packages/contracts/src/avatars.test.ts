import { describe, expect, it } from 'vitest';
import {
  avatarMutationResponseSchema,
  renderablePresetAvatarIdSchema,
  selectablePresetAvatarCatalogResponseSchema,
  selectablePresetAvatarIdSchema
} from './avatars.js';
import { authUserSchema } from './auth.js';

describe('avatar contracts', () => {
  it('keeps legacy preset ids renderable but not newly selectable', () => {
    expect(renderablePresetAvatarIdSchema.safeParse('preset-01').success).toBe(true);
    expect(selectablePresetAvatarIdSchema.safeParse('preset-01').success).toBe(false);
    expect(selectablePresetAvatarIdSchema.safeParse('preset-13').success).toBe(true);
    expect(selectablePresetAvatarIdSchema.safeParse('preset-24').success).toBe(true);
  });

  it('requires the current avatar in authenticated sessions', () => {
    expect(authUserSchema.parse({
      id: 'u1',
      username: 'test',
      nickname: '测试',
      role: 'USER',
      mustChangePassword: false,
      avatarKind: 'PRESET',
      avatarValue: 'preset-13'
    })).toMatchObject({ avatarKind: 'PRESET', avatarValue: 'preset-13' });
  });

  it('accepts only the complete selectable preset catalog with matching asset paths', () => {
    // Break caught: legacy, missing, duplicate or mismatched catalog entries reach the picker as selectable values.
    const presets = Array.from({ length: 12 }, (_, index) => {
      const id = `preset-${index + 13}`;
      return { id, path: `/avatars/${id}.webp` };
    });

    expect(selectablePresetAvatarCatalogResponseSchema.safeParse({ presets }).success).toBe(true);
    expect(selectablePresetAvatarCatalogResponseSchema.safeParse({
      presets: [{ id: 'preset-01', path: '/avatars/preset-01.webp' }, ...presets.slice(1)]
    }).success).toBe(false);
    expect(selectablePresetAvatarCatalogResponseSchema.safeParse({
      presets: [{ id: 'preset-13', path: '/avatars/preset-14.webp' }, ...presets.slice(1)]
    }).success).toBe(false);
    expect(selectablePresetAvatarCatalogResponseSchema.safeParse({ presets: presets.slice(0, 11) }).success).toBe(false);
  });

  it('validates preset and uploaded avatar mutation responses without rejecting the upload path', () => {
    // Break caught: a broad string response accepts legacy presets or unsafe upload paths.
    expect(avatarMutationResponseSchema.safeParse({
      avatarKind: 'PRESET',
      avatarValue: 'preset-24'
    }).success).toBe(true);
    expect(avatarMutationResponseSchema.safeParse({
      avatarKind: 'PRESET',
      avatarValue: 'preset-01'
    }).success).toBe(false);
    expect(avatarMutationResponseSchema.safeParse({
      avatarKind: 'UPLOAD',
      avatarValue: 'cm123-avatar-uuid.webp',
      path: 'cm123-avatar-uuid.webp'
    }).success).toBe(true);
    expect(avatarMutationResponseSchema.safeParse({
      avatarKind: 'UPLOAD',
      avatarValue: '../outside.webp',
      path: '../outside.webp'
    }).success).toBe(false);
    expect(avatarMutationResponseSchema.safeParse({
      avatarKind: 'UPLOAD',
      avatarValue: 'avatar.webp',
      path: 'different.webp'
    }).success).toBe(false);
  });
});
