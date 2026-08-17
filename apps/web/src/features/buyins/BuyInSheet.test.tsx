import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { csrfTokenStore } from '../../api/http-client.js';
import { jsonResponse } from '../../test/app-fixtures.js';
import { AdjustBuyInDialog } from './AdjustBuyInDialog.js';
import { BuyInSheet } from './BuyInSheet.js';

afterEach(() => {
  csrfTokenStore.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('offers quick hands, validates manual 1–99, and submits exact integer money', async () => {
  // Break caught: a quick option or the manual upper bound produces an invalid purchase request.
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    void input;
    void init;
    return jsonResponse({
    eventId: 'event-1', gameId: 'game-1', playerId: 'player-self', actorUserId: 'self',
    type: 'BUY', logicalBuyId: 'event-1', previousHands: null, newHands: 3,
    handsDelta: 3, replayed: false, gameVersion: 2
    }, 201);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');

  render(<BuyInSheet gameId="game-1" handPrice="300" open canWrite onClose={() => undefined} onSuccess={() => undefined} />);

  expect(screen.getAllByRole('button', { name: /^购买 \d+ 手$/ })).toHaveLength(5);
  await user.click(screen.getByRole('button', { name: '购买 3 手' }));
  expect(screen.getByText((_, element) => (
    element?.classList.contains('sheet-total') === true && element.textContent === '本次金额 ¥900'
  ))).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '确认购买 3 手' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const [, init] = fetchMock.mock.calls[0]!;
  expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/games/game-1/buyins');
  expect(JSON.parse(String(init?.body))).toEqual({
    hands: 3,
    idempotencyKey: '11111111-1111-4111-8111-111111111111'
  });
});

it('retries an uncertain purchase with the identical idempotency key', async () => {
  // Break caught: retrying after an unknown network result generates a second ledger purchase.
  const user = userEvent.setup();
  const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
    .mockRejectedValueOnce(new TypeError('network result unknown'))
    .mockResolvedValueOnce(jsonResponse({
      eventId: 'event-1', gameId: 'game-1', playerId: 'player-self', actorUserId: 'self',
      type: 'BUY', logicalBuyId: 'event-1', previousHands: null, newHands: 2,
      handsDelta: 2, replayed: true, gameVersion: 2
    }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('22222222-2222-4222-8222-222222222222');

  render(<BuyInSheet gameId="game-1" handPrice="300" open canWrite onClose={() => undefined} onSuccess={() => undefined} />);
  await user.click(screen.getByRole('button', { name: '购买 2 手' }));
  await user.click(screen.getByRole('button', { name: '确认购买 2 手' }));
  expect(await screen.findByRole('button', { name: '使用同一请求重试' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '使用同一请求重试' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  const keys = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).idempotencyKey);
  expect(keys).toEqual([
    '22222222-2222-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222222'
  ]);
});

it('keeps one purchase key through consecutive uncertain HTTP failures and rotates it only after success', async () => {
  // Break caught: a 5xx ApiError clears the pending key and a retry can duplicate a committed ledger purchase.
  const user = userEvent.setup();
  const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce(jsonResponse({ code: 'INTERNAL_ERROR' }, 503))
    .mockResolvedValueOnce(jsonResponse({ code: 'HTTP_ERROR' }, 502))
    .mockResolvedValueOnce(jsonResponse({
      eventId: 'event-1', gameId: 'game-1', playerId: 'player-self', actorUserId: 'self',
      type: 'BUY', logicalBuyId: 'event-1', previousHands: null, newHands: 2,
      handsDelta: 2, replayed: true, gameVersion: 2
    }))
    .mockResolvedValueOnce(jsonResponse({
      eventId: 'event-2', gameId: 'game-1', playerId: 'player-self', actorUserId: 'self',
      type: 'BUY', logicalBuyId: 'event-2', previousHands: null, newHands: 2,
      handsDelta: 2, replayed: false, gameVersion: 3
    }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(globalThis.crypto, 'randomUUID')
    .mockReturnValueOnce('44444444-4444-4444-8444-444444444444')
    .mockReturnValueOnce('55555555-5555-4555-8555-555555555555');

  render(<BuyInSheet gameId="game-1" handPrice="300" open canWrite onClose={() => undefined} onSuccess={() => undefined} />);
  await user.click(screen.getByRole('button', { name: '购买 2 手' }));
  await user.click(screen.getByRole('button', { name: '确认购买 2 手' }));
  await user.click(await screen.findByRole('button', { name: '使用同一请求重试' }));
  await user.click(await screen.findByRole('button', { name: '使用同一请求重试' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  await user.click(screen.getByRole('button', { name: '确认购买 2 手' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

  expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).idempotencyKey)).toEqual([
    '44444444-4444-4444-8444-444444444444',
    '44444444-4444-4444-8444-444444444444',
    '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555'
  ]);
});

it('keeps invalid manual hands out of the ledger', async () => {
  // Break caught: browser number controls alone allow out-of-range or non-integer hands through code paths.
  const user = userEvent.setup();
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  render(<BuyInSheet gameId="game-1" handPrice="300" open canWrite onClose={() => undefined} onSuccess={() => undefined} />);

  const input = screen.getByRole('spinbutton', { name: '购买手数' });
  fireEvent.change(input, { target: { value: '100' } });
  await user.click(screen.getByRole('button', { name: '确认购买' }));

  expect(screen.getByRole('alert')).toHaveTextContent('请输入 1–99 手');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('disables the ledger write while the browser is offline', () => {
  // Break caught: a visibly offline PWA can still submit a write it cannot safely confirm.
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
  render(<BuyInSheet gameId="game-1" handPrice="300" open canWrite onClose={() => undefined} onSuccess={() => undefined} />);

  expect(screen.getByRole('button', { name: '确认购买 1 手' })).toBeDisabled();
});

it('allows correcting the current user latest logical buy to zero', async () => {
  // Break caught: an adjustment deletes history or incorrectly rejects zero, which is the audit-safe reversal value.
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    void input;
    void init;
    return jsonResponse({
    eventId: 'adjust-1', gameId: 'game-1', playerId: 'player-self', actorUserId: 'self',
    type: 'ADJUST', logicalBuyId: 'event-1', previousHands: 5, newHands: 0,
    handsDelta: -5, replayed: false, gameVersion: 3
    }, 201);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('33333333-3333-4333-8333-333333333333');

  render(<AdjustBuyInDialog gameId="game-1" playerId="player-self" currentHands={5} open canWrite onClose={() => undefined} onSuccess={() => undefined} />);
  const input = screen.getByRole('spinbutton', { name: '更正后手数' });
  await user.clear(input);
  await user.type(input, '0');
  await user.click(screen.getByRole('button', { name: '确认更正为 0 手' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(String(url)).toContain('/api/games/game-1/players/player-self/buyins/latest/adjust');
  expect(JSON.parse(String(init?.body))).toEqual({
    newHands: 0,
    idempotencyKey: '33333333-3333-4333-8333-333333333333'
  });
});

it('keeps one adjustment key through consecutive uncertain HTTP failures and rotates it only after success', async () => {
  // Break caught: a proxy 502/504 response generates a new correction key before the first outcome is known.
  const user = userEvent.setup();
  const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce(jsonResponse({ code: 'HTTP_ERROR' }, 504))
    .mockResolvedValueOnce(jsonResponse({ code: 'INTERNAL_ERROR' }, 503))
    .mockResolvedValueOnce(jsonResponse({
      eventId: 'adjust-1', gameId: 'game-1', playerId: 'player-self', actorUserId: 'self',
      type: 'ADJUST', logicalBuyId: 'event-1', previousHands: 5, newHands: 3,
      handsDelta: -2, replayed: true, gameVersion: 3
    }))
    .mockResolvedValueOnce(jsonResponse({
      eventId: 'adjust-2', gameId: 'game-1', playerId: 'player-self', actorUserId: 'self',
      type: 'ADJUST', logicalBuyId: 'event-1', previousHands: 3, newHands: 2,
      handsDelta: -1, replayed: false, gameVersion: 4
    }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(globalThis.crypto, 'randomUUID')
    .mockReturnValueOnce('66666666-6666-4666-8666-666666666666')
    .mockReturnValueOnce('77777777-7777-4777-8777-777777777777');

  render(<AdjustBuyInDialog gameId="game-1" playerId="player-self" currentHands={5} open canWrite onClose={() => undefined} onSuccess={() => undefined} />);
  const input = screen.getByRole('spinbutton', { name: '更正后手数' });
  await user.clear(input);
  await user.type(input, '3');
  await user.click(screen.getByRole('button', { name: '确认更正为 3 手' }));
  await user.click(await screen.findByRole('button', { name: '使用同一请求重试' }));
  await user.click(await screen.findByRole('button', { name: '使用同一请求重试' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  await user.click(screen.getByRole('button', { name: '确认更正为 3 手' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

  expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).idempotencyKey)).toEqual([
    '66666666-6666-4666-8666-666666666666',
    '66666666-6666-4666-8666-666666666666',
    '66666666-6666-4666-8666-666666666666',
    '77777777-7777-4777-8777-777777777777'
  ]);
});

it('releases a rejected purchase key after a controlled four-hundred response', async () => {
  // Break caught: a request the server explicitly rejected remains permanently locked to the old key.
  const user = userEvent.setup();
  const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce(jsonResponse({ code: 'GAME_STATE_CONFLICT' }, 409))
    .mockResolvedValueOnce(jsonResponse({
      eventId: 'event-2', gameId: 'game-1', playerId: 'player-self', actorUserId: 'self',
      type: 'BUY', logicalBuyId: 'event-2', previousHands: null, newHands: 1,
      handsDelta: 1, replayed: false, gameVersion: 3
    }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(globalThis.crypto, 'randomUUID')
    .mockReturnValueOnce('88888888-8888-4888-8888-888888888888')
    .mockReturnValueOnce('99999999-9999-4999-8999-999999999999');

  render(<BuyInSheet gameId="game-1" handPrice="300" open canWrite onClose={() => undefined} onSuccess={() => undefined} />);
  await user.click(screen.getByRole('button', { name: '确认购买 1 手' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('对局状态已变化');
  await user.click(screen.getByRole('button', { name: '确认购买 1 手' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

  expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).idempotencyKey)).toEqual([
    '88888888-8888-4888-8888-888888888888',
    '99999999-9999-4999-8999-999999999999'
  ]);
});

it('blocks a purchase submit when the game becomes non-writable after the sheet opened', async () => {
  // Break caught: a stale open sheet submits after an ACTIVE snapshot has already changed to SETTLING.
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const view = render(<BuyInSheet gameId="game-1" handPrice="300" open canWrite onClose={() => undefined} onSuccess={() => undefined} />);
  view.rerender(<BuyInSheet gameId="game-1" handPrice="300" open canWrite={false} onClose={() => undefined} onSuccess={() => undefined} />);

  expect(screen.getByRole('spinbutton', { name: '购买手数' })).toBeDisabled();
  fireEvent.submit(screen.getByRole('spinbutton', { name: '购买手数' }).closest('form')!);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('blocks an adjustment submit when the game becomes non-writable after the dialog opened', () => {
  // Break caught: a stale correction dialog writes after the server has stopped the game.
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const view = render(<AdjustBuyInDialog gameId="game-1" playerId="player-self" currentHands={5} open canWrite onClose={() => undefined} onSuccess={() => undefined} />);
  view.rerender(<AdjustBuyInDialog gameId="game-1" playerId="player-self" currentHands={5} open canWrite={false} onClose={() => undefined} onSuccess={() => undefined} />);

  expect(screen.getByRole('spinbutton', { name: '更正后手数' })).toBeDisabled();
  fireEvent.submit(screen.getByRole('spinbutton', { name: '更正后手数' }).closest('form')!);
  expect(fetchMock).not.toHaveBeenCalled();
});
