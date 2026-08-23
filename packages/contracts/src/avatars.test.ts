import { describe, expect, it } from 'vitest';
import {
  renderablePresetAvatarIdSchema,
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
});
