import { z } from 'zod';

const SIGNED_BIGINT_MAX = '9223372036854775807';
const CANONICAL_NON_NEGATIVE_INTEGER = /^(0|[1-9]\d*)$/;

function isWithinSignedBigIntMaximum(value: string): boolean {
  if (!CANONICAL_NON_NEGATIVE_INTEGER.test(value)) return true;
  return value.length < SIGNED_BIGINT_MAX.length ||
    (value.length === SIGNED_BIGINT_MAX.length && value <= SIGNED_BIGINT_MAX);
}

export const nonNegativeMoneyJsonSchema = z.string()
  .regex(CANONICAL_NON_NEGATIVE_INTEGER)
  .refine(isWithinSignedBigIntMaximum, { message: 'Money value exceeds signed BIGINT maximum' });

export const rakeSettingsResponseSchema = z.object({
  threshold: nonNegativeMoneyJsonSchema,
  bps: z.number().int().min(0).max(10_000),
  version: z.number().int().positive()
});

export const updateRakeSettingsSchema = rakeSettingsResponseSchema;

export type RakeSettingsDto = z.infer<typeof rakeSettingsResponseSchema>;
export type UpdateRakeSettingsRequest = z.infer<typeof updateRakeSettingsSchema>;
