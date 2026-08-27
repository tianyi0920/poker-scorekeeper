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

export type HoldemEquityWorkerClientFactory = () => HoldemEquityWorkerClient;

const idleState: HoldemEquityState = { status: 'idle', result: null };

export function useHoldemEquity(
  submittedInput: HoldemEquityInput | null,
  createClient: HoldemEquityWorkerClientFactory = createHoldemEquityWorkerClient
): HoldemEquityState {
  const clientRef = useRef<HoldemEquityWorkerClient | null>(null);
  const disposalGenerationRef = useRef(0);
  const [state, setState] = useState<HoldemEquityState>(idleState);

  let client = clientRef.current;
  if (client === null) {
    client = createClient();
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
      setState(idleState);
      return;
    }

    let active = true;
    setState({ status: 'loading', result: null });
    void client.calculate(submittedInput).then(
      (result) => {
        if (active) setState({ status: 'success', result });
      },
      () => {
        if (active) setState({ status: 'error', result: null });
      }
    );

    return () => {
      active = false;
      client.cancel();
    };
  }, [submittedInput]);

  return state;
}
