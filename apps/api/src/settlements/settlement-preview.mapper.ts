import {
  formatMoney,
  type SettlementDraftPayload,
  type SettlementPreviewDto,
  type SettlementValidationCode
} from '@poker/contracts';
import { calculateSettlement } from '@poker/settlement';
import { foldBuyinEvents, type LedgerEvent } from '../buyins/buyin-ledger.js';
import type {
  BuyinEvent,
  Game,
  GamePlayer,
  SystemSetting,
  User
} from '../generated/prisma/client.js';

const MAX_SIGNED_BIGINT = 9223372036854775807n;
const MIN_SIGNED_BIGINT = -9223372036854775808n;

export interface PreviewPlayer extends GamePlayer {
  user: Pick<User, 'rakeEnabled'>;
}

export interface PreviewContext {
  game: Game;
  players: PreviewPlayer[];
  buyinEvents: BuyinEvent[];
  settings: SystemSetting;
}

interface PlayerAmount {
  player: PreviewPlayer;
  buyIn: bigint;
  cashOut: bigint;
  rawProfit: bigint;
  entered: boolean;
}

function ledgerEvent(event: BuyinEvent): LedgerEvent {
  return {
    id: event.id,
    type: event.type,
    logicalBuyId: event.logicalBuyId,
    previousHands: event.previousHands,
    newHands: event.newHands,
    handsDelta: event.handsDelta
  };
}

function isSignedBigInt(value: bigint): boolean {
  return value >= MIN_SIGNED_BIGINT && value <= MAX_SIGNED_BIGINT;
}

function allSignedBigInt(values: readonly bigint[]): boolean {
  return values.every(isSignedBigInt);
}

function playerAmounts(
  context: PreviewContext,
  payload: SettlementDraftPayload
): PlayerAmount[] {
  return [...context.players]
    .sort((left, right) => left.seatNo - right.seatNo || left.id.localeCompare(right.id))
    .map((player) => {
      const effectiveHands = foldBuyinEvents(
        context.buyinEvents
          .filter(({ gamePlayerId }) => gamePlayerId === player.id)
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() ||
            left.id.localeCompare(right.id))
          .map(ledgerEvent)
      ).reduce((total, buy) => total + buy.effectiveHands, 0);
      const buyIn = context.game.handPrice * BigInt(effectiveHands);
      const rawCashOut = payload.cashOutByPlayerId[player.id]!;
      const entered = rawCashOut !== '';
      const cashOut = entered ? BigInt(rawCashOut) : 0n;
      return {
        player,
        buyIn,
        cashOut,
        rawProfit: entered ? cashOut - buyIn : 0n,
        entered
      };
    });
}

function validationCode(
  amounts: readonly PlayerAmount[],
  payload: SettlementDraftPayload
): SettlementValidationCode | null {
  const buyInTotal = amounts.reduce((sum, row) => sum + row.buyIn, 0n);
  const cashOutTotal = amounts.reduce((sum, row) => sum + row.cashOut, 0n);
  if (!allSignedBigInt([
    ...amounts.flatMap((row) => [row.buyIn, row.cashOut, row.rawProfit]),
    buyInTotal,
    cashOutTotal,
    BigInt(payload.roomFee),
    BigInt(payload.otherFee)
  ])) return 'MONEY_OVERFLOW';
  if (amounts.some(({ entered }) => !entered)) return 'CASH_OUTS_INCOMPLETE';
  if (cashOutTotal !== buyInTotal) return 'TABLE_NOT_BALANCED';
  const playerIds = new Set(amounts.map(({ player }) => player.id));
  if (
    payload.roomPayerIds.some((id) => !playerIds.has(id)) ||
    payload.otherPayerIds.some((id) => !playerIds.has(id))
  ) return 'UNKNOWN_FEE_PAYER';
  if (payload.roomFee !== '0' && payload.roomPayerIds.length === 0) {
    return 'ROOM_FEE_PAYERS_REQUIRED';
  }
  if (payload.otherFee !== '0' && payload.otherPayerIds.length === 0) {
    return 'OTHER_FEE_PAYERS_REQUIRED';
  }
  return null;
}

function interimPreview(
  context: PreviewContext,
  amounts: readonly PlayerAmount[],
  payload: SettlementDraftPayload,
  draftVersion: number,
  code: SettlementValidationCode
): SettlementPreviewDto {
  const buyInTotal = amounts.reduce((sum, row) => sum + row.buyIn, 0n);
  const cashOutTotal = amounts.reduce((sum, row) => sum + row.cashOut, 0n);
  const rawProfitTotal = amounts.reduce((sum, row) => sum + row.rawProfit, 0n);
  return {
    draftVersion,
    settingsVersion: context.settings.version,
    previewReady: false,
    validationCode: code,
    totals: {
      buyIn: formatMoney(buyInTotal),
      cashOut: formatMoney(cashOutTotal),
      roomFee: payload.roomFee,
      otherFee: payload.otherFee,
      rake: '0',
      final: formatMoney(rawProfitTotal)
    },
    players: amounts.map(({ player, buyIn, cashOut, rawProfit }) => ({
      playerId: player.id,
      nickname: player.nicknameSnapshot,
      buyIn: formatMoney(buyIn),
      cashOut: formatMoney(cashOut),
      rawProfit: formatMoney(rawProfit),
      roomFeeShare: '0',
      otherFeeShare: '0',
      afterFeeProfit: formatMoney(rawProfit),
      rakeAmount: '0',
      finalAmount: formatMoney(rawProfit)
    }))
  };
}

export function buildSettlementPreview(
  context: PreviewContext,
  payload: SettlementDraftPayload,
  draftVersion: number
): SettlementPreviewDto {
  const amounts = playerAmounts(context, payload);
  const invalid = validationCode(amounts, payload);
  if (invalid !== null) return interimPreview(context, amounts, payload, draftVersion, invalid);

  const output = calculateSettlement({
    players: amounts.map(({ player, buyIn, cashOut }) => ({
      playerId: player.id,
      seatNo: player.seatNo,
      buyIn,
      cashOut,
      rakeEnabled: player.user.rakeEnabled
    })),
    gameRakeEnabled: context.game.rakeEnabled,
    rakeThreshold: context.settings.rakeThreshold,
    rakeBps: context.settings.rakeBps,
    roomFee: BigInt(payload.roomFee),
    roomPayerIds: payload.roomPayerIds,
    otherFee: BigInt(payload.otherFee),
    otherPayerIds: payload.otherPayerIds
  });
  const allCalculated = [
    output.buyInTotal,
    output.cashOutTotal,
    output.roomFeeTotal,
    output.otherFeeTotal,
    output.rakeTotal,
    output.finalTotal,
    ...output.results.flatMap((row) => [
      row.buyIn,
      row.cashOut,
      row.rawProfit,
      row.roomFeeShare,
      row.otherFeeShare,
      row.afterFeeProfit,
      row.rakeAmount,
      row.finalAmount
    ])
  ];
  if (!allSignedBigInt(allCalculated)) {
    return interimPreview(context, amounts, payload, draftVersion, 'MONEY_OVERFLOW');
  }
  const nicknameByPlayer = new Map(context.players.map((player) => [player.id, player.nicknameSnapshot]));
  return {
    draftVersion,
    settingsVersion: context.settings.version,
    previewReady: true,
    validationCode: null,
    totals: {
      buyIn: formatMoney(output.buyInTotal),
      cashOut: formatMoney(output.cashOutTotal),
      roomFee: formatMoney(output.roomFeeTotal),
      otherFee: formatMoney(output.otherFeeTotal),
      rake: formatMoney(output.rakeTotal),
      final: formatMoney(output.finalTotal)
    },
    players: output.results.map((row) => ({
      playerId: row.playerId,
      nickname: nicknameByPlayer.get(row.playerId)!,
      buyIn: formatMoney(row.buyIn),
      cashOut: formatMoney(row.cashOut),
      rawProfit: formatMoney(row.rawProfit),
      roomFeeShare: formatMoney(row.roomFeeShare),
      otherFeeShare: formatMoney(row.otherFeeShare),
      afterFeeProfit: formatMoney(row.afterFeeProfit),
      rakeAmount: formatMoney(row.rakeAmount),
      finalAmount: formatMoney(row.finalAmount)
    }))
  };
}

export function isCashOutCompleteAndBalanced(
  context: PreviewContext,
  payload: SettlementDraftPayload
): boolean {
  const amounts = playerAmounts(context, payload);
  return amounts.length > 0 &&
    amounts.every(({ entered }) => entered) &&
    amounts.reduce((sum, row) => sum + row.cashOut, 0n) ===
      amounts.reduce((sum, row) => sum + row.buyIn, 0n);
}

export function defaultFeePayersOnFirstBalance(
  context: PreviewContext,
  previousPayload: SettlementDraftPayload,
  nextPayload: SettlementDraftPayload
): SettlementDraftPayload {
  if (
    isCashOutCompleteAndBalanced(context, previousPayload) ||
    !isCashOutCompleteAndBalanced(context, nextPayload)
  ) return nextPayload;
  const amounts = playerAmounts(context, nextPayload);
  const leader = [...amounts].sort((left, right) =>
    left.rawProfit === right.rawProfit
      ? left.player.seatNo - right.player.seatNo
      : left.rawProfit > right.rawProfit ? -1 : 1
  )[0];
  if (leader === undefined) return nextPayload;
  return {
    ...nextPayload,
    roomPayerIds: nextPayload.roomFee !== '0' && nextPayload.roomPayerIds.length === 0
      ? [leader.player.id]
      : nextPayload.roomPayerIds,
    otherPayerIds: nextPayload.otherFee !== '0' && nextPayload.otherPayerIds.length === 0
      ? [leader.player.id]
      : nextPayload.otherPayerIds
  };
}
