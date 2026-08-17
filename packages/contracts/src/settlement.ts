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
