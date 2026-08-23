import type { SelectablePresetAvatarId } from '@poker/contracts';

export interface PresetAvatar {
  id: SelectablePresetAvatarId;
  path: string;
}

const SELECTABLE_PRESET_IDS: readonly SelectablePresetAvatarId[] = [
  'preset-13', 'preset-14', 'preset-15', 'preset-16', 'preset-17', 'preset-18',
  'preset-19', 'preset-20', 'preset-21', 'preset-22', 'preset-23', 'preset-24'
];

export const DEFAULT_PRESET_AVATAR: SelectablePresetAvatarId = 'preset-13';

export const PRESET_AVATARS: readonly PresetAvatar[] = SELECTABLE_PRESET_IDS.map((id) => ({
  id,
  path: `/avatars/${id}.webp`
}));
