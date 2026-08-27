import type { HoldemCard, HoldemEquityPlayer, HoldemEquityResult } from './holdem-equity.js';

export const HOLD_EM_EQUITY_WORKER_FAILURE_MESSAGE = '精确计算失败，请重试';

export interface HoldemEquityInput {
  players: HoldemEquityPlayer[];
  boardCards: HoldemCard[];
}

export interface HoldemEquityWorkerRequest {
  requestId: number;
  input: HoldemEquityInput;
}

export type HoldemEquityWorkerResponse =
  | { requestId: number; ok: true; result: HoldemEquityResult }
  | { requestId: number; ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPercentage(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

export function isHoldemEquityRequestId(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

export function isHoldemEquityInput(value: unknown): value is HoldemEquityInput {
  if (!isRecord(value) || !Array.isArray(value.players) || !isStringArray(value.boardCards)) return false;

  return value.players.every((player) => (
    isRecord(player)
    && typeof player.id === 'string'
    && player.id.length > 0
    && isStringArray(player.cards)
  ));
}

export function isHoldemEquityResult(value: unknown): value is HoldemEquityResult {
  if (!isRecord(value) || value.mode !== 'exact') return false;
  if (typeof value.samples !== 'number' || !Number.isFinite(value.samples) || !Number.isInteger(value.samples) || value.samples < 0) {
    return false;
  }
  if (!Array.isArray(value.players) || value.players.length < 2) return false;

  return value.players.every((player) => (
    isRecord(player)
    && typeof player.id === 'string'
    && player.id.length > 0
    && isPercentage(player.equityPercentage)
    && isPercentage(player.winPercentage)
    && isPercentage(player.tiePercentage)
  ));
}

export function isHoldemEquityWorkerRequest(value: unknown): value is HoldemEquityWorkerRequest {
  return isRecord(value)
    && isHoldemEquityRequestId(value.requestId)
    && isHoldemEquityInput(value.input);
}

export function isHoldemEquityWorkerResponse(value: unknown): value is HoldemEquityWorkerResponse {
  if (!isRecord(value) || !isHoldemEquityRequestId(value.requestId)) return false;

  if (value.ok === true) return isHoldemEquityResult(value.result);
  return value.ok === false && typeof value.message === 'string' && value.message.length > 0;
}
