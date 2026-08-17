import { SettlementError } from '@poker/contracts';
import type {
  RakeConfig,
  SettlementInput,
  SettlementOutput,
  SettlementPlayerResult,
} from '@poker/contracts';
import { allocateExpense } from './allocate-expense.js';

export function calculateRake(afterFeeProfit: bigint, config: RakeConfig): bigint {
  const eligible = config.gameEnabled
    && config.userEnabled
    && afterFeeProfit >= config.threshold
    && afterFeeProfit > 0n;
  return eligible ? (afterFeeProfit * BigInt(config.bps) + 5000n) / 10000n : 0n;
}

export function calculateSettlement(input: SettlementInput): SettlementOutput {
  const buyInTotal = input.players.reduce((sum, player) => sum + player.buyIn, 0n);
  const cashOutTotal = input.players.reduce((sum, player) => sum + player.cashOut, 0n);
  const rawProfitByPlayer = input.players.map((player) => ({
    playerId: player.playerId,
    seatNo: player.seatNo,
    rawProfit: player.cashOut - player.buyIn,
  }));
  const rawProfitTotal = rawProfitByPlayer.reduce((sum, player) => sum + player.rawProfit, 0n);

  const roomShares = allocateExpense(input.roomFee, input.roomPayerIds, rawProfitByPlayer);
  const otherShares = allocateExpense(input.otherFee, input.otherPayerIds, rawProfitByPlayer);
  const results: SettlementPlayerResult[] = input.players.map((player) => {
    const rawProfit = player.cashOut - player.buyIn;
    const roomFeeShare = roomShares.get(player.playerId) ?? 0n;
    const otherFeeShare = otherShares.get(player.playerId) ?? 0n;
    const afterFeeProfit = rawProfit - roomFeeShare - otherFeeShare;
    const rakeEligible = input.gameRakeEnabled
      && player.rakeEnabled
      && afterFeeProfit >= input.rakeThreshold
      && afterFeeProfit > 0n;
    const rakeAmount = calculateRake(afterFeeProfit, {
      gameEnabled: input.gameRakeEnabled,
      userEnabled: player.rakeEnabled,
      threshold: input.rakeThreshold,
      bps: input.rakeBps,
    });
    return {
      ...player,
      rawProfit,
      roomFeeShare,
      otherFeeShare,
      afterFeeProfit,
      rakeEligible,
      rakeAmount,
      finalAmount: afterFeeProfit - rakeAmount,
    };
  });

  const rakeTotal = results.reduce((sum, player) => sum + player.rakeAmount, 0n);
  const finalTotal = results.reduce((sum, player) => sum + player.finalAmount, 0n);
  const roomFeeTotal = results.reduce((sum, player) => sum + player.roomFeeShare, 0n);
  const otherFeeTotal = results.reduce((sum, player) => sum + player.otherFeeShare, 0n);

  if (cashOutTotal !== buyInTotal) throw new SettlementError('TABLE_NOT_BALANCED');
  if (rawProfitTotal !== 0n) throw new SettlementError('RAW_PROFIT_NOT_ZERO');
  if (finalTotal !== -(input.roomFee + input.otherFee + rakeTotal)) {
    throw new SettlementError('FINAL_TOTAL_INVALID');
  }

  return {
    results,
    buyInTotal,
    cashOutTotal,
    rawProfitTotal,
    roomFeeTotal,
    otherFeeTotal,
    rakeTotal,
    finalTotal,
  };
}
