import { describe, expect, it } from 'vitest';
import type { HoldemEquityResult } from './holdem-equity.js';
import type { HoldemEquityInput } from './holdem-equity-worker-protocol.js';
import {
  HOLD_EM_EQUITY_CALCULATION_CANCELLED_MESSAGE,
  HOLD_EM_EQUITY_CALCULATION_DISPOSED_MESSAGE,
  HOLD_EM_EQUITY_WORKER_FAILURE_MESSAGE,
  createHoldemEquityWorkerClient,
  type HoldemEquityWorkerLike
} from './holdem-equity-worker-client.js';

class FakeWorker implements HoldemEquityWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly postedMessages: unknown[] = [];
  terminateCalls = 0;
  private queuedMessageHandler: ((event: MessageEvent<unknown>) => void) | null = null;

  postMessage(message: unknown): void {
    this.postedMessages.push(message);
    this.queuedMessageHandler = this.onmessage;
  }

  terminate(): void {
    this.terminateCalls += 1;
  }

  respond(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }

  respondLate(data: unknown): void {
    this.queuedMessageHandler?.({ data } as MessageEvent<unknown>);
  }

  fail(): void {
    this.onerror?.({} as ErrorEvent);
  }
}

const input: HoldemEquityInput = {
  players: [
    { id: 'aces', cards: ['As', 'Ah'] },
    { id: 'kings', cards: ['Kc', 'Kd'] }
  ],
  boardCards: ['2c', '7d', '9h']
};

const firstResult: HoldemEquityResult = {
  mode: 'exact',
  samples: 990,
  players: [
    { id: 'aces', equityPercentage: 91.6, winPercentage: 91.6, tiePercentage: 0 },
    { id: 'kings', equityPercentage: 8.4, winPercentage: 8.4, tiePercentage: 0 }
  ]
};

const secondResult: HoldemEquityResult = {
  mode: 'exact',
  samples: 990,
  players: [
    { id: 'aces', equityPercentage: 12.3, winPercentage: 12.3, tiePercentage: 0 },
    { id: 'kings', equityPercentage: 87.7, winPercentage: 87.7, tiePercentage: 0 }
  ]
};

function createClientWithFakeWorkers() {
  const workers: FakeWorker[] = [];
  const client = createHoldemEquityWorkerClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });

  return { client, workers };
}

describe('createHoldemEquityWorkerClient', () => {
  it('resolves a matching, well-formed exact result', async () => {
    // Break caught: a valid Worker response is ignored or delivered as a malformed result.
    const { client, workers } = createClientWithFakeWorkers();
    const calculation = client.calculate(input);

    expect(workers).toHaveLength(1);
    expect(workers[0]?.postedMessages).toEqual([{ requestId: 1, input }]);

    workers[0]?.respond({ requestId: 1, ok: true, result: firstResult });

    await expect(calculation).resolves.toEqual(firstResult);
    expect(workers[0]?.terminateCalls).toBe(1);
  });

  it('cancels the first request and accepts only the second request after a rapid recalculation', async () => {
    // Break caught: a terminated Worker can publish its queued result over a newer calculation.
    const { client, workers } = createClientWithFakeWorkers();
    const firstCalculation = client.calculate(input);
    const secondCalculation = client.calculate(input);

    await expect(firstCalculation).rejects.toThrow(HOLD_EM_EQUITY_CALCULATION_CANCELLED_MESSAGE);
    expect(workers[0]?.terminateCalls).toBe(1);
    expect(workers[1]?.postedMessages).toEqual([{ requestId: 2, input }]);

    workers[0]?.respondLate({ requestId: 1, ok: true, result: firstResult });
    workers[1]?.respond({ requestId: 2, ok: true, result: secondResult });

    await expect(secondCalculation).resolves.toEqual(secondResult);
    expect(workers[0]?.terminateCalls).toBe(1);
    expect(workers[1]?.terminateCalls).toBe(1);
  });

  it('rejects a Worker runtime error with the stable failure message', async () => {
    // Break caught: browser-specific Worker errors leak through to the user-facing calculation state.
    const { client, workers } = createClientWithFakeWorkers();
    const calculation = client.calculate(input);

    workers[0]?.fail();

    await expect(calculation).rejects.toThrow(HOLD_EM_EQUITY_WORKER_FAILURE_MESSAGE);
    expect(workers[0]?.terminateCalls).toBe(1);
  });

  it('rejects a malformed result envelope with the stable failure message', async () => {
    // Break caught: an incomplete Worker payload is treated as a usable equity result.
    const { client, workers } = createClientWithFakeWorkers();
    const calculation = client.calculate(input);

    workers[0]?.respond({
      requestId: 1,
      ok: true,
      result: { mode: 'simulated', samples: 990, players: [] }
    });

    await expect(calculation).rejects.toThrow(HOLD_EM_EQUITY_WORKER_FAILURE_MESSAGE);
  });

  it('rejects a response envelope with an unusable request ID', async () => {
    // Break caught: a non-positive or non-integer response ID is accepted as the active request.
    const { client, workers } = createClientWithFakeWorkers();
    const calculation = client.calculate(input);

    workers[0]?.respond({ requestId: 0, ok: true, result: firstResult });

    await expect(calculation).rejects.toThrow(HOLD_EM_EQUITY_WORKER_FAILURE_MESSAGE);
  });

  it('rejects an explicit Worker failure without exposing its message', async () => {
    // Break caught: evaluator failures expose stack fragments or selected cards through the client.
    const { client, workers } = createClientWithFakeWorkers();
    const calculation = client.calculate(input);

    workers[0]?.respond({ requestId: 1, ok: false, message: 'As Ah evaluator stack' });

    await expect(calculation).rejects.toThrow(HOLD_EM_EQUITY_WORKER_FAILURE_MESSAGE);
  });

  it('cancels an active request exactly once and drops its queued result', async () => {
    // Break caught: explicit cancellation leaves a live Worker that can later settle its stale promise.
    const { client, workers } = createClientWithFakeWorkers();
    const calculation = client.calculate(input);

    client.cancel();
    client.cancel();
    workers[0]?.respondLate({ requestId: 1, ok: true, result: firstResult });

    await expect(calculation).rejects.toThrow(HOLD_EM_EQUITY_CALCULATION_CANCELLED_MESSAGE);
    expect(workers[0]?.terminateCalls).toBe(1);
  });

  it('disposes an active Worker exactly once and rejects future calculations', async () => {
    // Break caught: an unmounted calculator leaves a Worker running or can be used again afterward.
    const { client, workers } = createClientWithFakeWorkers();
    const calculation = client.calculate(input);

    client.dispose();
    client.dispose();

    await expect(calculation).rejects.toThrow(HOLD_EM_EQUITY_CALCULATION_CANCELLED_MESSAGE);
    await expect(client.calculate(input)).rejects.toThrow(HOLD_EM_EQUITY_CALCULATION_DISPOSED_MESSAGE);
    expect(workers[0]?.terminateCalls).toBe(1);
  });
});
