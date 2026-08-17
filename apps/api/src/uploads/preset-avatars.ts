import type { PresetAvatarId } from '@poker/contracts';

export interface PresetAvatar {
  id: PresetAvatarId;
  path: string;
}

export const DEFAULT_PRESET_AVATAR: PresetAvatarId = 'preset-01';

export const PRESET_AVATARS: readonly PresetAvatar[] = Array.from(
  { length: 12 },
  (_, index) => {
    const id = `preset-${String(index + 1).padStart(2, '0')}` as PresetAvatarId;
    return { id, path: `/avatars/${id}.webp` };
  }
);
