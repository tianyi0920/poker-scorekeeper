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

export interface HoldemEquitySubmission {
  input: HoldemEquityInput;
  requestId: number;
}

const idleState: HoldemEquityState = { status: 'idle', result: null };
const loadingState: HoldemEquityState = { status: 'loading', result: null };

interface InputBoundState {
  submissionSignature: string | null;
  state: HoldemEquityState;
}

function submissionSignature(submission: HoldemEquitySubmission): string {
  return `${submission.requestId}:${JSON.stringify(submission.input)}`;
}

export function useHoldemEquity(submission: HoldemEquitySubmission | null): HoldemEquityState {
  const clientRef = useRef<HoldemEquityWorkerClient | null>(null);
  const disposalGenerationRef = useRef(0);
  const [inputBoundState, setInputBoundState] = useState<InputBoundState>({
    submissionSignature: null,
    state: idleState
  });
  const currentSubmissionSignature = submission === null ? null : submissionSignature(submission);

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
    if (submission === null) {
      setInputBoundState({ submissionSignature: null, state: idleState });
      return;
    }

    let active = true;
    setInputBoundState({ submissionSignature: currentSubmissionSignature, state: loadingState });
    void client.calculate(submission.input).then(
      (result) => {
        if (active) setInputBoundState({
          submissionSignature: currentSubmissionSignature,
          state: { status: 'success', result }
        });
      },
      () => {
        if (active) setInputBoundState({
          submissionSignature: currentSubmissionSignature,
          state: { status: 'error', result: null }
        });
      }
    );

    return () => {
      active = false;
      client.cancel();
    };
  }, [currentSubmissionSignature]);

  if (submission === null) return idleState;
  return inputBoundState.submissionSignature === currentSubmissionSignature
    ? inputBoundState.state
    : loadingState;
}
