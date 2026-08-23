import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { GameSocketClient, GameSocketListener } from '../../api/game-socket.js';
import { useGameDeletedSubscription } from './useGameDeletedSubscription.js';

class FakeGameSocket implements GameSocketClient {
  connected = false;
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  joinAcknowledgement: unknown = { ok: true, gameId: 'game-1', version: 1, snapshotSent: false };
  connectCalls = 0;
  disconnectCalls = 0;
  private readonly listeners = new Map<string, Set<GameSocketListener>>();

  on(event: string, listener: GameSocketListener): this {
    const listeners = this.listeners.get(event) ?? new Set<GameSocketListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: GameSocketListener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, payload?: unknown, acknowledgement?: (value: unknown) => void): this {
    this.emitted.push({ event, payload });
    if (event === 'game.join' && acknowledgement !== undefined) acknowledgement(this.joinAcknowledgement);
    return this;
  }

  connect(): this {
    this.connectCalls += 1;
    this.connected = true;
    this.fire('connect');
    return this;
  }

  disconnect(): this {
    this.disconnectCalls += 1;
    this.connected = false;
    return this;
  }

  fire(event: string, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }
}

afterEach(() => vi.restoreAllMocks());

it('joins at version zero and accepts one matching shared deletion event while ignoring snapshots and invalid events', () => {
  // Break caught: the settlement-only socket consumes financial snapshots or redirects for malformed/other-game events.
  const socket = new FakeGameSocket();
  const onDeleted = vi.fn();
  const socketFactory = vi.fn(() => socket);
  const { unmount } = renderHook(() => useGameDeletedSubscription('game-1', onDeleted, socketFactory));

  expect(socketFactory).toHaveBeenCalledTimes(1);
  expect(socket.emitted).toContainEqual({ event: 'game.join', payload: { gameId: 'game-1', knownVersion: 0 } });

  act(() => {
    socket.fire('game.snapshot', { id: 'game-1', version: 99 });
    socket.fire('game.deleted', { gameId: 'game-1', reason: 'SOFT_DELETED' });
    socket.fire('game.deleted', { gameId: 'game-2', reason: 'HARD_DELETED' });
    socket.fire('game.deleted', { gameId: 'game-1', reason: 'HARD_DELETED', extra: true });
  });
  expect(onDeleted).not.toHaveBeenCalled();

  act(() => {
    socket.fire('game.deleted', { gameId: 'game-1', reason: 'HARD_DELETED' });
    socket.fire('game.deleted', { gameId: 'game-1', reason: 'HARD_DELETED' });
  });
  expect(onDeleted).toHaveBeenCalledTimes(1);

  unmount();
  expect(socket.emitted).toContainEqual({ event: 'game.leave', payload: { gameId: 'game-1' } });
  expect(socket.listenerCount()).toBe(0);
  expect(socket.disconnectCalls).toBe(1);
});

it('cleans the old listener and creates one fresh socket when the settlement route changes', () => {
  // Break caught: route switching leaves the prior game subscribed or reuses a socket carrying stale room state.
  const first = new FakeGameSocket();
  const second = new FakeGameSocket();
  const sockets = [first, second];
  const onDeleted = vi.fn();
  const socketFactory = vi.fn(() => sockets.shift()!);
  const { rerender, unmount } = renderHook(
    ({ gameId }) => useGameDeletedSubscription(gameId, onDeleted, socketFactory),
    { initialProps: { gameId: 'game-1' } }
  );

  rerender({ gameId: 'game-2' });
  expect(first.listenerCount()).toBe(0);
  expect(first.disconnectCalls).toBe(1);
  expect(first.emitted).toContainEqual({ event: 'game.leave', payload: { gameId: 'game-1' } });
  expect(second.emitted).toContainEqual({ event: 'game.join', payload: { gameId: 'game-2', knownVersion: 0 } });

  act(() => first.fire('game.deleted', { gameId: 'game-1', reason: 'HARD_DELETED' }));
  expect(onDeleted).not.toHaveBeenCalled();
  act(() => second.fire('game.deleted', { gameId: 'game-2', reason: 'HARD_DELETED' }));
  expect(onDeleted).toHaveBeenCalledTimes(1);

  unmount();
  expect(second.listenerCount()).toBe(0);
  expect(second.disconnectCalls).toBe(1);
});

it.each(['join acknowledgement', 'server error'] as const)(
  'uses confirmed existence to recover a missed deletion from NOT_FOUND %s',
  (source) => {
    // Break caught: a settlement socket misses game.deleted while offline and never exits after the deleted room rejects rejoin.
    const socket = new FakeGameSocket();
    const onDeleted = vi.fn();
    const { unmount } = renderHook(() => useGameDeletedSubscription('game-1', onDeleted, () => socket, false));
    expect(onDeleted).not.toHaveBeenCalled();

    if (source === 'join acknowledgement') {
      socket.joinAcknowledgement = { ok: false, code: 'NOT_FOUND' };
      act(() => socket.fire('connect'));
    } else {
      act(() => socket.fire('server.error', { code: 'NOT_FOUND' }));
    }

    expect(onDeleted).toHaveBeenCalledTimes(1);
    unmount();
    expect(socket.listenerCount()).toBe(0);
  }
);

it('holds an early strict NOT_FOUND until a later draft proves the game existed', () => {
  // Break caught: NOT_FOUND arrives first, is discarded, and no later socket event remains to exit after the draft succeeds.
  const socket = new FakeGameSocket();
  socket.joinAcknowledgement = { ok: false, code: 'NOT_FOUND' };
  const onDeleted = vi.fn();
  const socketFactory = () => socket;
  const { rerender } = renderHook(
    ({ knownGameExists }) => useGameDeletedSubscription('game-1', onDeleted, socketFactory, knownGameExists),
    { initialProps: { knownGameExists: false } }
  );
  expect(onDeleted).not.toHaveBeenCalled();

  rerender({ knownGameExists: true });

  expect(onDeleted).toHaveBeenCalledTimes(1);
});

it('does not turn an initially missing game or malformed protocol data into a deletion', () => {
  // Break caught: an arbitrary bad route receives the privileged deletion notice without any evidence of prior existence.
  const socket = new FakeGameSocket();
  socket.joinAcknowledgement = { ok: true, gameId: 'game-1' };
  const onDeleted = vi.fn();
  const { unmount } = renderHook(() => useGameDeletedSubscription('game-1', onDeleted, () => socket, false));

  act(() => {
    socket.fire('server.error', { code: 'NOT_FOUND', extra: true });
    socket.fire('server.error', { code: 'FORBIDDEN' });
    socket.fire('server.error', { code: 'NOT_FOUND' });
  });

  expect(onDeleted).not.toHaveBeenCalled();
  unmount();
  expect(socket.listenerCount()).toBe(0);
});
