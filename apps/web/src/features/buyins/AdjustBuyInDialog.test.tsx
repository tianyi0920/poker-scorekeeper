import { act, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { csrfTokenStore } from '../../api/http-client.js';
import { AdjustBuyInDialog } from './AdjustBuyInDialog.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfil) => { resolve = fulfil; });
  return { promise, resolve };
}

afterEach(() => {
  csrfTokenStore.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('forwards the game lifecycle signal and ignores a late successful adjustment after abort', async () => {
  // Break caught: a correction completed after hard deletion refreshes the departed game page.
  const user = userEvent.setup();
  const pending = deferred<Response>();
  let requestSignal: AbortSignal | null | undefined;
  let bodyParsed = false;
  vi.stubGlobal('fetch', vi.fn((_input: string | URL | Request, init?: RequestInit) => {
    requestSignal = init?.signal;
    return pending.promise;
  }));
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-123456789abc');
  const onClose = vi.fn();
  const onSuccess = vi.fn();
  const controller = new AbortController();

  render(
    <AdjustBuyInDialog
      gameId="game-1"
      playerId="player-self"
      currentHands={5}
      open
      canWrite
      signal={controller.signal}
      onClose={onClose}
      onSuccess={onSuccess}
    />
  );
  const input = screen.getByRole('spinbutton', { name: '更正后手数' });
  await user.clear(input);
  await user.type(input, '3');
  await user.click(screen.getByRole('button', { name: '确认更正为 3 手' }));

  await waitFor(() => expect(requestSignal).toBe(controller.signal));
  controller.abort();
  await act(async () => {
    pending.resolve({
      ok: true,
      json: async () => {
        bodyParsed = true;
        return {
          eventId: 'adjust-1', gameId: 'game-1', playerId: 'player-self', actorUserId: 'self',
          type: 'ADJUST', logicalBuyId: 'event-1', previousHands: 5, newHands: 3,
          handsDelta: -2, replayed: false, gameVersion: 2
        };
      }
    } as Response);
    await pending.promise;
  });
  await waitFor(() => expect(bodyParsed).toBe(true));
  await act(async () => { await Promise.resolve(); });

  expect(requestSignal?.aborted).toBe(true);
  expect(onSuccess).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});
