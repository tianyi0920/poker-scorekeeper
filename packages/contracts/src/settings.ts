import { z } from 'zod';

export const nonNegativeMoneyJsonSchema = z.string().regex(/^(0|[1-9]\d*)$/);

export const rakeSettingsResponseSchema = z.object({
  threshold: nonNegativeMoneyJsonSchema,
  bps: z.number().int().min(0).max(10_000),
  version: z.number().int().positive()
});

export const updateRakeSettingsSchema = rakeSettingsResponseSchema;

export type RakeSettingsDto = z.infer<typeof rakeSettingsResponseSchema>;
export type UpdateRakeSettingsRequest = z.infer<typeof updateRakeSettingsSchema>;
