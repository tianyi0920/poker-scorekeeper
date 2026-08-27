import { useEffect, useRef, useState } from 'react';
import type { HoldemEquityResult } from './holdem-equity.js';
import type { HoldemEquityInput } from './holdem-equity-worker-protocol.js';
import {
  createHoldemEquityWorkerClient,
  type HoldemEquityWorkerClient
} from './holdem-equity-worker-client.js';

export type HoldemEquityState =
  | { status: 'idle'; result: null }
  | { status: 'loading'; result: null }
  | { status: 'success'; result: HoldemEquityResult }
  | { status: 'error'; result: null };

const idleState: HoldemEquityState = { status: 'idle', result: null };
const loadingState: HoldemEquityState = { status: 'loading', result: null };

interface InputBoundState {
  input: HoldemEquityInput | null;
  inputSignature: string | null;
  state: HoldemEquityState;
}

function inputSignature(input: HoldemEquityInput): string {
  return JSON.stringify(input);
}

export function useHoldemEquity(submittedInput: HoldemEquityInput | null): HoldemEquityState {
  const clientRef = useRef<HoldemEquityWorkerClient | null>(null);
  const disposalGenerationRef = useRef(0);
  const [inputBoundState, setInputBoundState] = useState<InputBoundState>({
    input: null,
    inputSignature: null,
    state: idleState
  });
  const submittedInputSignature = submittedInput === null ? null : inputSignature(submittedInput);

  let client = clientRef.current;
  if (client === null) {
    client = createHoldemEquityWorkerClient();
    clientRef.current = client;
  }

  useEffect(() => {
    disposalGenerationRef.current += 1;
    return () => {
      const disposalGeneration = disposalGenerationRef.current + 1;
      disposalGenerationRef.current = disposalGeneration;
      queueMicrotask(() => {
        if (disposalGenerationRef.current === disposalGeneration) clientRef.current?.dispose();
      });
    };
  }, []);

  useEffect(() => {
    if (submittedInput === null) {
      setInputBoundState({ input: null, inputSignature: null, state: idleState });
      return;
    }

    let active = true;
    setInputBoundState({ input: submittedInput, inputSignature: submittedInputSignature, state: loadingState });
    void client.calculate(submittedInput).then(
      (result) => {
        if (active) setInputBoundState({
          input: submittedInput,
          inputSignature: submittedInputSignature,
          state: { status: 'success', result }
        });
      },
      () => {
        if (active) setInputBoundState({
          input: submittedInput,
          inputSignature: submittedInputSignature,
          state: { status: 'error', result: null }
        });
      }
    );

    return () => {
      active = false;
      client.cancel();
    };
  }, [submittedInput, submittedInputSignature]);

  if (submittedInput === null) return idleState;
  return inputBoundState.input === submittedInput && inputBoundState.inputSignature === submittedInputSignature
    ? inputBoundState.state
    : loadingState;
}
