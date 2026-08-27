import type { HoldemEquityResult } from './holdem-equity.js';
import {
  HOLD_EM_EQUITY_WORKER_FAILURE_MESSAGE,
  isHoldemEquityWorkerResponse,
  type HoldemEquityInput,
  type HoldemEquityWorkerRequest
} from './holdem-equity-worker-protocol.js';

export { HOLD_EM_EQUITY_WORKER_FAILURE_MESSAGE } from './holdem-equity-worker-protocol.js';

export const HOLD_EM_EQUITY_CALCULATION_CANCELLED_MESSAGE = '精确计算已取消';
export const HOLD_EM_EQUITY_CALCULATION_DISPOSED_MESSAGE = '精确计算器已释放';

export interface HoldemEquityWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: HoldemEquityWorkerRequest): void;
  terminate(): void;
}

export type HoldemEquityWorkerFactory = () => HoldemEquityWorkerLike;

export interface HoldemEquityWorkerClient {
  calculate(input: HoldemEquityInput): Promise<HoldemEquityResult>;
  cancel(): void;
  dispose(): void;
}

interface ActiveCalculation {
  worker: HoldemEquityWorkerLike;
  requestId: number;
  resolve: (result: HoldemEquityResult) => void;
  reject: (error: Error) => void;
  terminated: boolean;
}

function createBrowserWorker(): HoldemEquityWorkerLike {
  return new Worker(new URL('./holdem-equity.worker.ts', import.meta.url), { type: 'module' }) as unknown as HoldemEquityWorkerLike;
}

class PerInstanceHoldemEquityWorkerClient implements HoldemEquityWorkerClient {
  private active: ActiveCalculation | null = null;
  private disposed = false;
  private nextRequestId = 0;

  constructor(private readonly workerFactory: HoldemEquityWorkerFactory) {}

  calculate(input: HoldemEquityInput): Promise<HoldemEquityResult> {
    if (this.disposed) return Promise.reject(new Error(HOLD_EM_EQUITY_CALCULATION_DISPOSED_MESSAGE));

    this.cancelActive(HOLD_EM_EQUITY_CALCULATION_CANCELLED_MESSAGE);
    const requestId = this.nextRequestId + 1;
    this.nextRequestId = requestId;

    let worker: HoldemEquityWorkerLike;
    try {
      worker = this.workerFactory();
    } catch {
      return Promise.reject(new Error(HOLD_EM_EQUITY_WORKER_FAILURE_MESSAGE));
    }

    return new Promise<HoldemEquityResult>((resolve, reject) => {
      const active: ActiveCalculation = { worker, requestId, resolve, reject, terminated: false };
      this.active = active;
      worker.onmessage = (event) => this.handleMessage(active, event.data);
      worker.onerror = () => this.rejectActive(active, HOLD_EM_EQUITY_WORKER_FAILURE_MESSAGE);

      try {
        worker.postMessage({ requestId, input });
      } catch {
        this.rejectActive(active, HOLD_EM_EQUITY_WORKER_FAILURE_MESSAGE);
      }
    });
  }

  cancel(): void {
    this.cancelActive(HOLD_EM_EQUITY_CALCULATION_CANCELLED_MESSAGE);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelActive(HOLD_EM_EQUITY_CALCULATION_CANCELLED_MESSAGE);
  }

  private handleMessage(active: ActiveCalculation, value: unknown): void {
    if (this.active !== active) return;
    if (!isHoldemEquityWorkerResponse(value)) {
      this.rejectActive(active, HOLD_EM_EQUITY_WORKER_FAILURE_MESSAGE);
      return;
    }
    if (value.requestId !== active.requestId) return;
    if (!value.ok) {
      this.rejectActive(active, HOLD_EM_EQUITY_WORKER_FAILURE_MESSAGE);
      return;
    }

    this.resolveActive(active, value.result);
  }

  private resolveActive(active: ActiveCalculation, result: HoldemEquityResult): void {
    if (this.active !== active) return;
    this.active = null;
    this.cleanupWorker(active);
    active.resolve(result);
  }

  private rejectActive(active: ActiveCalculation, message: string): void {
    if (this.active !== active) return;
    this.active = null;
    this.cleanupWorker(active);
    active.reject(new Error(message));
  }

  private cancelActive(message: string): void {
    if (this.active !== null) this.rejectActive(this.active, message);
  }

  private cleanupWorker(active: ActiveCalculation): void {
    active.worker.onmessage = null;
    active.worker.onerror = null;
    if (active.terminated) return;

    active.terminated = true;
    try {
      active.worker.terminate();
    } catch {
      // Worker termination is best-effort and must not change the calculation outcome.
    }
  }
}

export function createHoldemEquityWorkerClient(
  workerFactory: HoldemEquityWorkerFactory = createBrowserWorker
): HoldemEquityWorkerClient {
  return new PerInstanceHoldemEquityWorkerClient(workerFactory);
}
