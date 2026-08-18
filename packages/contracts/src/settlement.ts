import { z } from 'zod';
import { canonicalPublicIdSchema } from './buyins.js';
import { moneyJsonSchema } from './money.js';
import { nonNegativeMoneyJsonSchema } from './settings.js';

const uniquePlayerIdsSchema = z.array(canonicalPublicIdSchema).max(12)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'DUPLICATE_PLAYER_ID' });

export const settlementDraftPayloadSchema = z.object({
  cashOutByPlayerId: z.record(
    canonicalPublicIdSchema,
    z.union([z.literal(''), nonNegativeMoneyJsonSchema])
  ).refine((cashOuts) => Object.keys(cashOuts).length <= 12, {
    message: 'TOO_MANY_PLAYERS'
  }),
  roomFee: nonNegativeMoneyJsonSchema.default('380'),
  roomPayerIds: uniquePlayerIdsSchema.default([]),
  otherFee: nonNegativeMoneyJsonSchema.default('0'),
  otherFeeNote: z.string().trim().max(100).default(''),
  otherPayerIds: uniquePlayerIdsSchema.default([])
}).strict().superRefine((value, context) => {
  if (value.otherFee !== '0' && value.otherFeeNote.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['otherFeeNote'],
      message: 'OTHER_FEE_NOTE_REQUIRED'
    });
  }
});

export const saveSettlementDraftSchema = z.object({
  version: z.number().int().positive(),
  payload: settlementDraftPayloadSchema
}).strict();

export const settlementPreviewRequestSchema = settlementDraftPayloadSchema;

export type SettlementDraftPayload = z.infer<typeof settlementDraftPayloadSchema>;
export type SaveSettlementDraftRequest = z.infer<typeof saveSettlementDraftSchema>;

export const settlementValidationCodeSchema = z.enum([
  'CASH_OUTS_INCOMPLETE',
  'TABLE_NOT_BALANCED',
  'ROOM_FEE_PAYERS_REQUIRED',
  'OTHER_FEE_PAYERS_REQUIRED',
  'UNKNOWN_FEE_PAYER',
  'MONEY_OVERFLOW'
]);

export const settlementPlayerBreakdownSchema = z.object({
  playerId: canonicalPublicIdSchema,
  nickname: z.string().min(1).max(64),
  avatarKind: z.enum(['PRESET', 'UPLOAD']),
  avatarValue: z.string().min(1).max(512),
  seatNo: z.number().int().min(1).max(12),
  buyIn: moneyJsonSchema,
  cashOut: moneyJsonSchema,
  rawProfit: moneyJsonSchema,
  roomFeeShare: moneyJsonSchema,
  otherFeeShare: moneyJsonSchema,
  afterFeeProfit: moneyJsonSchema,
  rakeEligible: z.boolean(),
  rakeAmount: moneyJsonSchema,
  finalAmount: moneyJsonSchema
}).strict();

export const settlementBreakdownSchema = z.object({
  totals: z.object({
    buyIn: moneyJsonSchema,
    cashOut: moneyJsonSchema,
    roomFee: moneyJsonSchema,
    otherFee: moneyJsonSchema,
    rake: moneyJsonSchema,
    final: moneyJsonSchema
  }).strict(),
  players: z.array(settlementPlayerBreakdownSchema).max(12)
}).strict();

export const settlementPreviewResponseSchema = settlementBreakdownSchema.extend({
  draftVersion: z.number().int().positive(),
  settingsVersion: z.number().int().positive(),
  previewReady: z.boolean(),
  validationCode: settlementValidationCodeSchema.nullable(),
  confirmationToken: z.string().min(1)
});

export const finalizeSettlementSchema = z.object({
  draftVersion: z.number().int().positive(),
  settingsVersion: z.number().int().positive(),
  confirmationToken: z.string().min(1).max(512)
}).strict();

export const settlementDraftResponseSchema = settlementPreviewResponseSchema.extend({
  gameId: canonicalPublicIdSchema,
  version: z.number().int().positive(),
  editorUserId: canonicalPublicIdSchema,
  editorNickname: z.string().min(1).max(64),
  leaseExpiresAt: z.iso.datetime({ offset: true }),
  canEdit: z.boolean(),
  canTakeOver: z.boolean(),
  payload: settlementDraftPayloadSchema
});

export type SettlementValidationCode = z.infer<typeof settlementValidationCodeSchema>;
export type SettlementBreakdownDto = z.infer<typeof settlementBreakdownSchema>;
export type SettlementPreviewDto = z.infer<typeof settlementPreviewResponseSchema>;
export type SettlementDraftDto = z.infer<typeof settlementDraftResponseSchema>;
export type FinalizeSettlementRequest = z.infer<typeof finalizeSettlementSchema>;

export interface SettlementPlayerInput {
  playerId: string;
  seatNo: number;
  buyIn: bigint;
  cashOut: bigint;
  rakeEnabled: boolean;
}

export interface SettlementInput {
  players: SettlementPlayerInput[];
  gameRakeEnabled: boolean;
  rakeThreshold: bigint;
  rakeBps: number;
  roomFee: bigint;
  roomPayerIds: string[];
  otherFee: bigint;
  otherPayerIds: string[];
}

export interface SettlementPlayerResult extends SettlementPlayerInput {
  rawProfit: bigint;
  roomFeeShare: bigint;
  otherFeeShare: bigint;
  afterFeeProfit: bigint;
  rakeEligible: boolean;
  rakeAmount: bigint;
  finalAmount: bigint;
}

export interface SettlementOutput {
  results: SettlementPlayerResult[];
  buyInTotal: bigint;
  cashOutTotal: bigint;
  rawProfitTotal: bigint;
  roomFeeTotal: bigint;
  otherFeeTotal: bigint;
  rakeTotal: bigint;
  finalTotal: bigint;
}

export interface ProfitOrder {
  playerId: string;
  seatNo: number;
  rawProfit: bigint;
}

export interface RakeConfig {
  gameEnabled: boolean;
  userEnabled: boolean;
  threshold: bigint;
  bps: number;
}

export class SettlementError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SettlementError';
  }
}
