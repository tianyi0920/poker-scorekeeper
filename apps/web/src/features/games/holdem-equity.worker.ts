import { calculateHoldemEquity } from './holdem-equity.js';
import {
  HOLD_EM_EQUITY_WORKER_FAILURE_MESSAGE,
  isHoldemEquityRequestId,
  isHoldemEquityWorkerRequest,
  type HoldemEquityWorkerResponse
} from './holdem-equity-worker-protocol.js';

interface EquityWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: HoldemEquityWorkerResponse): void;
}

const workerScope = self as unknown as EquityWorkerScope;

function requestIdFromMalformedEnvelope(value: unknown): number | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const requestId = (value as Record<string, unknown>).requestId;
  return isHoldemEquityRequestId(requestId) ? requestId : null;
}

workerScope.onmessage = (event) => {
  const request = event.data;
  if (!isHoldemEquityWorkerRequest(request)) {
    const requestId = requestIdFromMalformedEnvelope(request);
    if (requestId !== null) {
      workerScope.postMessage({ requestId, ok: false, message: HOLD_EM_EQUITY_WORKER_FAILURE_MESSAGE });
    }
    return;
  }

  try {
    workerScope.postMessage({
      requestId: request.requestId,
      ok: true,
      result: calculateHoldemEquity(request.input)
    });
  } catch {
    workerScope.postMessage({
      requestId: request.requestId,
      ok: false,
      message: HOLD_EM_EQUITY_WORKER_FAILURE_MESSAGE
    });
  }
};
