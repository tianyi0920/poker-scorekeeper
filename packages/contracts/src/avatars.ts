import { z } from 'zod';

export const legacyPresetAvatarIdSchema = z.enum([
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

export const selectablePresetAvatarIdSchema = z.enum([
  'preset-13',
  'preset-14',
  'preset-15',
  'preset-16',
  'preset-17',
  'preset-18',
  'preset-19',
  'preset-20',
  'preset-21',
  'preset-22',
  'preset-23',
  'preset-24'
]);

export const renderablePresetAvatarIdSchema = z.union([
  legacyPresetAvatarIdSchema,
  selectablePresetAvatarIdSchema
]);

export const presetAvatarIdSchema = renderablePresetAvatarIdSchema;

export const selectPresetAvatarSchema = z.object({
  presetId: selectablePresetAvatarIdSchema
});

export type RenderablePresetAvatarId = z.infer<typeof renderablePresetAvatarIdSchema>;
export type SelectablePresetAvatarId = z.infer<typeof selectablePresetAvatarIdSchema>;
export type PresetAvatarId = RenderablePresetAvatarId;
export type SelectPresetAvatarRequest = z.infer<typeof selectPresetAvatarSchema>;
