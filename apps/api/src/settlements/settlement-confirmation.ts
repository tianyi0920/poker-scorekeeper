import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SettlementDraftPayload } from '@poker/contracts';
import type { PreviewContext } from './settlement-preview.mapper.js';

interface ConfirmationBinding {
  gameId: string;
  draftVersion: number;
  payload: SettlementDraftPayload;
  settingsVersion: number;
  rakeEnabledByPlayerId: Record<string, boolean>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function secret(): string {
  const configured = process.env.SETTLEMENT_CONFIRMATION_SECRET ?? process.env.CSRF_SECRET;
  if (configured !== undefined && configured.length > 0) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SETTLEMENT_CONFIRMATION_SECRET is required in production');
  }
  return 'development-only';
}

export function settlementConfirmationToken(
  context: PreviewContext,
  payload: SettlementDraftPayload,
  draftVersion: number
): string {
  const rakeEnabledByPlayerId = Object.fromEntries(context.players
    .map((player) => [player.id, player.user.rakeEnabled] as const)
    .sort(([left], [right]) => left.localeCompare(right)));
  const binding: ConfirmationBinding = {
    gameId: context.game.id,
    draftVersion,
    payload,
    settingsVersion: context.settings.version,
    rakeEnabledByPlayerId
  };
  return createHmac('sha256', secret()).update(stableJson(binding)).digest('base64url');
}

export function matchesSettlementConfirmation(expected: string, candidate: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return expectedBytes.length === candidateBytes.length &&
    timingSafeEqual(expectedBytes, candidateBytes);
}
