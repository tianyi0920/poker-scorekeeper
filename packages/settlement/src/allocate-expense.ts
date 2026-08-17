import { SettlementError } from '@poker/contracts';
import type { ProfitOrder } from '@poker/contracts';

export function allocateExpense(
  total: bigint,
  payerIds: string[],
  players: ProfitOrder[],
): Map<string, bigint> {
  if (total < 0n) throw new SettlementError('FEE_NEGATIVE');
  if (total > 0n && payerIds.length === 0) throw new SettlementError('FEE_PAYERS_REQUIRED');
  if (total === 0n) return new Map(payerIds.map((id) => [id, 0n]));

  const selected = players
    .filter((player) => payerIds.includes(player.playerId))
    .sort((left, right) =>
      left.rawProfit === right.rawProfit
        ? left.seatNo - right.seatNo
        : left.rawProfit > right.rawProfit ? -1 : 1,
    );

  if (selected.length !== new Set(payerIds).size) {
    throw new SettlementError('UNKNOWN_FEE_PAYER');
  }

  const divisor = BigInt(selected.length);
  const quotient = total / divisor;
  const remainder = total % divisor;
  return new Map(selected.map((player, index) => [
    player.playerId,
    quotient + (BigInt(index) < remainder ? 1n : 0n),
  ]));
}
