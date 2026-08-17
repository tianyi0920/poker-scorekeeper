import {
  settlementDraftPayloadSchema,
  type SettlementDraftPayload
} from '@poker/contracts';
import { badRequest } from '../common/errors/app-error.js';

export function defaultSettlementDraftPayload(playerIds: readonly string[]): SettlementDraftPayload {
  return settlementDraftPayloadSchema.parse({
    cashOutByPlayerId: Object.fromEntries(playerIds.map((playerId) => [playerId, '']))
  });
}

export function parseStoredSettlementDraftPayload(value: unknown): SettlementDraftPayload {
  return settlementDraftPayloadSchema.parse(value);
}

export function assertExactDraftPlayerSet(
  payload: SettlementDraftPayload,
  playerIds: readonly string[]
): void {
  const expected = [...playerIds].sort();
  const actual = Object.keys(payload.cashOutByPlayerId).sort();
  if (
    actual.length !== expected.length ||
    actual.some((playerId, index) => playerId !== expected[index])
  ) {
    throw badRequest('VALIDATION_ERROR');
  }
}
