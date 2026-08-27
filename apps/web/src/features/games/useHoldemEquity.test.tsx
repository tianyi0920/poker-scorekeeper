import { act, render, renderHook, screen } from '@testing-library/react';
import { StrictMode, useState, type ReactNode } from 'react';
import { afterEach, expect, expectTypeOf, it, vi } from 'vitest';
import type { HoldemEquityResult } from './holdem-equity.js';
import type { HoldemEquityInput } from './holdem-equity-worker-protocol.js';
import {
  createHoldemEquityWorkerClient,
  type HoldemEquityWorkerClient
} from './holdem-equity-worker-client.js';
import { useHoldemEquity } from './useHoldemEquity.js';

vi.mock('./holdem-equity-worker-client.js', () => ({
  createHoldemEquityWorkerClient: vi.fn()
}));

afterEach(() => vi.resetAllMocks());

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

function installClient(client: ControllableClient): void {
  vi.mocked(createHoldemEquityWorkerClient).mockReturnValue(client);
}

function suppressOnlyActWarnings(): ReturnType<typeof vi.spyOn> {
  const reportUnexpectedError = console.error;
  return vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (args.some((arg) => String(arg).includes('not wrapped in act'))) return;
    reportUnexpectedError(...args);
  });
}

it('accepts only submitted input through its production API', () => {
  // Break caught: test-only Worker construction is exposed as a second production Hook argument.
  expectTypeOf<Parameters<typeof useHoldemEquity>['length']>().toEqualTypeOf<1>();
});

it('stays idle for null input and cancels an active calculation when the submitted input is cleared', () => {
  // Break caught: clearing card selections leaves an old exact result or Worker calculation active.
  const client = new ControllableClient();
  installClient(client);
  const { result, rerender } = renderHook(
    ({ input }) => useHoldemEquity(input),
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
  installClient(client);
  const { result, rerender } = renderHook(
    ({ input }) => useHoldemEquity(input),
    { initialProps: { input: inputA } }
  );

  await act(async () => {
    client.calculations[0]!.resolve(firstResult);
    await client.calculations[0]!.promise;
  });
  expect(result.current).toEqual({ status: 'success', result: firstResult });

  rerender({ input: inputB });

  expect(createHoldemEquityWorkerClient).toHaveBeenCalledTimes(1);
  expect(client.inputs).toEqual([inputA, inputB]);
  expect(result.current).toEqual({ status: 'loading', result: null });
});

it('keeps a successful result without cancelling when a new submitted object has equivalent content', async () => {
  // Break caught: a parent recreates an unchanged submission and needlessly restarts exact enumeration.
  const client = new ControllableClient();
  installClient(client);
  const equivalentInputA = JSON.parse(JSON.stringify(inputA)) as HoldemEquityInput;
  const { result, rerender } = renderHook(
    ({ input }) => useHoldemEquity(input),
    { initialProps: { input: inputA } }
  );

  await act(async () => {
    client.calculations[0]!.resolve(firstResult);
    await client.calculations[0]!.promise;
  });
  rerender({ input: equivalentInputA });

  expect(client.inputs).toEqual([inputA]);
  expect(client.cancelCalls).toBe(0);
  expect(result.current).toEqual({ status: 'success', result: firstResult });
});

it('does not return a prior success on the first render after submitted input changes', async () => {
  // Break caught: a native card-confirmation click commits new input while the Hook still returns A's
  // success until its passive effect clears state, briefly rendering A's equity against B's cards.
  const client = new ControllableClient();
  installClient(client);

  function SubmittedInputSwitcher() {
    const [input, setInput] = useState<HoldemEquityInput>(inputA);
    const state = useHoldemEquity(input);
    return (
      <>
        <button type="button" onClick={() => setInput(inputB)}>replace submitted input</button>
        <output>{state.status}:{state.result?.players[0]?.id ?? 'none'}</output>
      </>
    );
  }

  render(<SubmittedInputSwitcher />);
  await act(async () => {
    client.calculations[0]!.resolve(firstResult);
    await client.calculations[0]!.promise;
  });
  expect(screen.getByRole('status')).toHaveTextContent('success:aces');

  const consoleError = suppressOnlyActWarnings();
  try {
    screen.getByRole('button', { name: 'replace submitted input' }).dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    );
    await Promise.resolve();
    expect(screen.getByRole('status')).toHaveTextContent('loading:none');
  } finally {
    consoleError.mockRestore();
  }
});

it('returns idle synchronously when submitted input is cleared', async () => {
  // Break caught: clearing the submitted deal renders its former success/error until a passive effect runs.
  const client = new ControllableClient();
  installClient(client);

  function SubmittedInputClearer() {
    const [input, setInput] = useState<HoldemEquityInput | null>(inputA);
    const state = useHoldemEquity(input);
    return (
      <>
        <button type="button" onClick={() => setInput(null)}>clear submitted input</button>
        <output>{state.status}:{state.result?.players[0]?.id ?? 'none'}</output>
      </>
    );
  }

  render(<SubmittedInputClearer />);
  await act(async () => {
    client.calculations[0]!.resolve(firstResult);
    await client.calculations[0]!.promise;
  });
  expect(screen.getByRole('status')).toHaveTextContent('success:aces');

  const consoleError = suppressOnlyActWarnings();
  try {
    screen.getByRole('button', { name: 'clear submitted input' }).dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    );
    await Promise.resolve();
    expect(screen.getByRole('status')).toHaveTextContent('idle:none');
  } finally {
    consoleError.mockRestore();
  }
});

it('hides a previous error on the first render after submitted input changes', async () => {
  // Break caught: a native card-confirmation click displays A's error against B's submitted cards.
  const client = new ControllableClient();
  installClient(client);

  function SubmittedInputSwitcher() {
    const [input, setInput] = useState<HoldemEquityInput>(inputA);
    const state = useHoldemEquity(input);
    return (
      <>
        <button type="button" onClick={() => setInput(inputB)}>replace submitted input</button>
        <output>{state.status}:{state.result?.players[0]?.id ?? 'none'}</output>
      </>
    );
  }

  render(<SubmittedInputSwitcher />);
  await act(async () => {
    client.calculations[0]!.reject(new Error('worker failed'));
    try {
      await client.calculations[0]!.promise;
    } catch {
      // The Hook owns the failure presentation; this test only waits for its state update.
    }
  });
  expect(screen.getByRole('status')).toHaveTextContent('error:none');

  const consoleError = suppressOnlyActWarnings();
  try {
    screen.getByRole('button', { name: 'replace submitted input' }).dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    );
    await Promise.resolve();
    expect(screen.getByRole('status')).toHaveTextContent('loading:none');
  } finally {
    consoleError.mockRestore();
  }
});

it('publishes a resolved calculation as a successful exact-equity state', async () => {
  // Break caught: a valid Worker result never reaches the shared UI state.
  const client = new ControllableClient();
  installClient(client);
  const { result } = renderHook(() => useHoldemEquity(inputA));

  await act(async () => {
    client.calculations[0]!.resolve(firstResult);
    await client.calculations[0]!.promise;
  });

  expect(result.current).toEqual({ status: 'success', result: firstResult });
});

it('clears the result and publishes an error state when calculation rejects', async () => {
  // Break caught: a failed Worker calculation leaks a stale success result or leaves the Hook loading forever.
  const client = new ControllableClient();
  installClient(client);
  const { result } = renderHook(() => useHoldemEquity(inputA));

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
  installClient(client);
  const { result, rerender } = renderHook(
    ({ input }) => useHoldemEquity(input),
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

it('does not publish an error when input A rejects after input B replaces it', async () => {
  // Break caught: a late rejection from a cancelled Worker replaces B's loading state with an error.
  const client = new ControllableClient();
  installClient(client);
  const { result, rerender } = renderHook(
    ({ input }) => useHoldemEquity(input),
    { initialProps: { input: inputA } }
  );

  rerender({ input: inputB });
  await act(async () => {
    client.calculations[0]!.reject(new Error('late worker failure'));
    try {
      await client.calculations[0]!.promise;
    } catch {
      // The Hook handles the rejected Worker promise.
    }
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
  installClient(client);
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { unmount } = renderHook(() => useHoldemEquity(inputA));

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
  installClient(client);
  const { result, unmount } = renderHook(() => useHoldemEquity(inputA), { wrapper: strictMode });

  expect(createHoldemEquityWorkerClient).toHaveBeenCalledTimes(1);
  expect(client.disposeCalls).toBe(0);
  await act(async () => {
    client.calculations.at(-1)!.resolve(firstResult);
    await client.calculations.at(-1)!.promise;
  });

  expect(result.current).toEqual({ status: 'success', result: firstResult });
  unmount();
  await act(async () => { await Promise.resolve(); });
  expect(client.disposeCalls).toBe(1);
});
