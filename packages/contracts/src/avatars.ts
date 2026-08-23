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

export const selectablePresetAvatarCatalogItemSchema = z.object({
  id: selectablePresetAvatarIdSchema,
  path: z.string()
}).strict().superRefine((item, context) => {
  if (item.path !== `/avatars/${item.id}.webp`) {
    context.addIssue({
      code: 'custom',
      path: ['path'],
      message: 'Preset avatar path does not match its id'
    });
  }
});

export const selectablePresetAvatarCatalogResponseSchema = z.object({
  presets: z.array(selectablePresetAvatarCatalogItemSchema).length(12)
}).strict().superRefine(({ presets }, context) => {
  if (new Set(presets.map(({ id }) => id)).size !== presets.length) {
    context.addIssue({
      code: 'custom',
      path: ['presets'],
      message: 'Preset avatar catalog contains duplicate ids'
    });
  }
});

export const uploadedAvatarFilenameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*\.webp$/);

const presetAvatarMutationResponseSchema = z.object({
  avatarKind: z.literal('PRESET'),
  avatarValue: selectablePresetAvatarIdSchema
}).strict();

const uploadAvatarMutationResponseSchema = z.object({
  avatarKind: z.literal('UPLOAD'),
  avatarValue: uploadedAvatarFilenameSchema,
  path: uploadedAvatarFilenameSchema.optional()
}).strict().superRefine((response, context) => {
  if (response.path !== undefined && response.path !== response.avatarValue) {
    context.addIssue({
      code: 'custom',
      path: ['path'],
      message: 'Uploaded avatar path does not match its filename'
    });
  }
});

export const avatarMutationResponseSchema = z.discriminatedUnion('avatarKind', [
  presetAvatarMutationResponseSchema,
  uploadAvatarMutationResponseSchema
]);

export type RenderablePresetAvatarId = z.infer<typeof renderablePresetAvatarIdSchema>;
export type SelectablePresetAvatarId = z.infer<typeof selectablePresetAvatarIdSchema>;
export type PresetAvatarId = RenderablePresetAvatarId;
export type SelectPresetAvatarRequest = z.infer<typeof selectPresetAvatarSchema>;
export type SelectablePresetAvatarCatalogItem = z.infer<typeof selectablePresetAvatarCatalogItemSchema>;
export type SelectablePresetAvatarCatalogResponse = z.infer<typeof selectablePresetAvatarCatalogResponseSchema>;
export type UploadedAvatarFilename = z.infer<typeof uploadedAvatarFilenameSchema>;
export type AvatarMutationResponse = z.infer<typeof avatarMutationResponseSchema>;
