import { act, renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import type { HoldemEquityResult } from './holdem-equity.js';
import type { HoldemEquityInput } from './holdem-equity-worker-protocol.js';
import type { HoldemEquityWorkerClient } from './holdem-equity-worker-client.js';
import { useHoldemEquity } from './useHoldemEquity.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const inputA: HoldemEquityInput = {
  players: [
    { id: 'aces', cards: ['As', 'Ah'] },
    { id: 'kings', cards: ['Kc', 'Kd'] }
  ],
  boardCards: ['2c', '7d', '9h']
};

const inputB: HoldemEquityInput = {
  players: [
    { id: 'queens', cards: ['Qs', 'Qh'] },
    { id: 'jacks', cards: ['Jc', 'Jd'] }
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
    { id: 'queens', equityPercentage: 12.3, winPercentage: 12.3, tiePercentage: 0 },
    { id: 'jacks', equityPercentage: 87.7, winPercentage: 87.7, tiePercentage: 0 }
  ]
};

class ControllableClient implements HoldemEquityWorkerClient {
  readonly inputs: HoldemEquityInput[] = [];
  readonly calculations: Array<ReturnType<typeof deferred<HoldemEquityResult>>> = [];
  cancelCalls = 0;
  disposeCalls = 0;

  calculate(input: HoldemEquityInput): Promise<HoldemEquityResult> {
    this.inputs.push(input);
    const calculation = deferred<HoldemEquityResult>();
    this.calculations.push(calculation);
    return calculation.promise;
  }

  cancel(): void {
    this.cancelCalls += 1;
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}

function strictMode({ children }: { children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>;
}

it('stays idle for null input and cancels an active calculation when the submitted input is cleared', () => {
  // Break caught: clearing card selections leaves an old exact result or Worker calculation active.
  const client = new ControllableClient();
  const { result, rerender } = renderHook(
    ({ input }) => useHoldemEquity(input, () => client),
    { initialProps: { input: inputA as HoldemEquityInput | null } }
  );

  expect(result.current).toEqual({ status: 'loading', result: null });
  rerender({ input: null });

  expect(result.current).toEqual({ status: 'idle', result: null });
  expect(client.cancelCalls).toBe(1);
});

it('creates one client per mount and clears a previous result while a new submitted input is loading', async () => {
  // Break caught: rendering recreates a calculator client or displays an obsolete result during recalculation.
  const client = new ControllableClient();
  const clientFactory = vi.fn(() => client);
  const { result, rerender } = renderHook(
    ({ input }) => useHoldemEquity(input, clientFactory),
    { initialProps: { input: inputA } }
  );

  await act(async () => {
    client.calculations[0]!.resolve(firstResult);
    await client.calculations[0]!.promise;
  });
  expect(result.current).toEqual({ status: 'success', result: firstResult });

  rerender({ input: inputB });

  expect(clientFactory).toHaveBeenCalledTimes(1);
  expect(client.inputs).toEqual([inputA, inputB]);
  expect(result.current).toEqual({ status: 'loading', result: null });
});

it('publishes a resolved calculation as a successful exact-equity state', async () => {
  // Break caught: a valid Worker result never reaches the shared UI state.
  const client = new ControllableClient();
  const { result } = renderHook(() => useHoldemEquity(inputA, () => client));

  await act(async () => {
    client.calculations[0]!.resolve(firstResult);
    await client.calculations[0]!.promise;
  });

  expect(result.current).toEqual({ status: 'success', result: firstResult });
});

it('clears the result and publishes an error state when calculation rejects', async () => {
  // Break caught: a failed Worker calculation leaks a stale success result or leaves the Hook loading forever.
  const client = new ControllableClient();
  const { result } = renderHook(() => useHoldemEquity(inputA, () => client));

  await act(async () => {
    client.calculations[0]!.reject(new Error('worker failed'));
    try {
      await client.calculations[0]!.promise;
    } catch {
      // The Hook owns the failure presentation; this test only waits for its state update.
    }
  });

  expect(result.current).toEqual({ status: 'error', result: null });
});

it('does not publish input A after input B replaces it and A resolves late', async () => {
  // Break caught: a late Worker response overwrites the current submitted card selection.
  const client = new ControllableClient();
  const { result, rerender } = renderHook(
    ({ input }) => useHoldemEquity(input, () => client),
    { initialProps: { input: inputA } }
  );

  rerender({ input: inputB });
  await act(async () => {
    client.calculations[0]!.resolve(firstResult);
    await client.calculations[0]!.promise;
  });
  expect(result.current).toEqual({ status: 'loading', result: null });

  await act(async () => {
    client.calculations[1]!.resolve(secondResult);
    await client.calculations[1]!.promise;
  });
  expect(result.current).toEqual({ status: 'success', result: secondResult });
});

it('disposes exactly once after unmount and ignores a late result without a React warning', async () => {
  // Break caught: an unmounted calculator retains a Worker or schedules a state update from its queued result.
  const client = new ControllableClient();
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { unmount } = renderHook(() => useHoldemEquity(inputA, () => client));

  unmount();
  await act(async () => {
    client.calculations[0]!.resolve(firstResult);
    await client.calculations[0]!.promise;
  });

  expect(client.disposeCalls).toBe(1);
  expect(consoleError).not.toHaveBeenCalled();
  consoleError.mockRestore();
});

it('remains usable through StrictMode effect cleanup without replacing its mounted client', async () => {
  // Break caught: StrictMode's setup-cleanup-setup cycle disposes the mounted client before its live request can settle.
  const client = new ControllableClient();
  const clientFactory = vi.fn(() => client);
  const { result } = renderHook(() => useHoldemEquity(inputA, clientFactory), { wrapper: strictMode });

  expect(clientFactory).toHaveBeenCalledTimes(1);
  await act(async () => {
    client.calculations.at(-1)!.resolve(firstResult);
    await client.calculations.at(-1)!.promise;
  });

  expect(result.current).toEqual({ status: 'success', result: firstResult });
});
