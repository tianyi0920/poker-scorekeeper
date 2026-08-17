import { z } from 'zod';

export const presetAvatarIdSchema = z.enum([
  'preset-01',
  'preset-02',
  'preset-03',
  'preset-04',
  'preset-05',
  'preset-06',
  'preset-07',
  'preset-08',
  'preset-09',
  'preset-10',
  'preset-11',
  'preset-12'
]);

export const selectPresetAvatarSchema = z.object({
  presetId: presetAvatarIdSchema
});

export type PresetAvatarId = z.infer<typeof presetAvatarIdSchema>;
export type SelectPresetAvatarRequest = z.infer<typeof selectPresetAvatarSchema>;
