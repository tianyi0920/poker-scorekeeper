import type { SettlementDraftPayload } from '@poker/contracts';
import type { SettlementOutput } from '@poker/contracts';
import { FeeType, type Prisma } from '../generated/prisma/client.js';
import type { PreviewContext } from './settlement-preview.mapper.js';

function allocationRows(
  settlementId: string,
  feeType: FeeType,
  total: bigint,
  payerIds: readonly string[],
  output: SettlementOutput
): Prisma.SettlementFeeAllocationCreateManyInput[] {
  if (total === 0n || payerIds.length === 0) return [];
  const payerSet = new Set(payerIds);
  const ordered = output.results
    .filter((result) => payerSet.has(result.playerId))
    .sort((left, right) => left.rawProfit === right.rawProfit
      ? left.seatNo - right.seatNo || left.playerId.localeCompare(right.playerId)
      : left.rawProfit > right.rawProfit ? -1 : 1);
  const divisor = BigInt(ordered.length);
  const quotient = total / divisor;
  const shares = new Map(output.results.map((result) => [
    result.playerId,
    feeType === FeeType.ROOM ? result.roomFeeShare : result.otherFeeShare
  ]));
  return ordered.map((result, index) => ({
    settlementId,
    feeType,
    gamePlayerId: result.playerId,
    allocationOrder: index + 1,
    amount: shares.get(result.playerId)!,
    receivedRemainder: shares.get(result.playerId)! > quotient
  }));
}

export async function persistSettlement(
  transaction: Prisma.TransactionClient,
  context: PreviewContext,
  payload: SettlementDraftPayload,
  output: SettlementOutput,
  actorId: string,
  actorNickname: string,
  lockedAt: Date
) {
  const settlement = await transaction.settlement.create({
    data: {
      gameId: context.game.id,
      buyInTotal: output.buyInTotal,
      cashOutTotal: output.cashOutTotal,
      roomFee: output.roomFeeTotal,
      otherFee: output.otherFeeTotal,
      otherFeeNote: payload.otherFeeNote,
      rakeThresholdUsed: context.settings.rakeThreshold,
      rakeBpsUsed: context.settings.rakeBps,
      settingsVersionUsed: context.settings.version,
      rakeTotal: output.rakeTotal,
      finalTotal: output.finalTotal,
      settledById: actorId,
      settledByNicknameSnapshot: actorNickname,
      lockedAt
    }
  });
  await transaction.settlementResult.createMany({
    data: output.results.map((result) => ({
      settlementId: settlement.id,
      gamePlayerId: result.playerId,
      buyIn: result.buyIn,
      cashOut: result.cashOut,
      rawProfit: result.rawProfit,
      roomFeeShare: result.roomFeeShare,
      otherFeeShare: result.otherFeeShare,
      afterFeeProfit: result.afterFeeProfit,
      rakeEligible: result.rakeEligible,
      rakeAmount: result.rakeAmount,
      finalAmount: result.finalAmount
    }))
  });
  await transaction.settlementFeeAllocation.createMany({
    data: [
      ...allocationRows(settlement.id, FeeType.ROOM, output.roomFeeTotal, payload.roomPayerIds, output),
      ...allocationRows(settlement.id, FeeType.OTHER, output.otherFeeTotal, payload.otherPayerIds, output)
    ]
  });
  return settlement;
}
