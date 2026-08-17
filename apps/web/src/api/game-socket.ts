import { io } from 'socket.io-client';

export type GameSocketListener = (...args: unknown[]) => void;

export interface GameSocketClient {
  connected: boolean;
  on(event: string, listener: GameSocketListener): this;
  off(event: string, listener: GameSocketListener): this;
  emit(event: string, payload?: unknown, acknowledgement?: (value: unknown) => void): this;
  connect(): this;
  disconnect(): this;
}

export function createGameSocket(): GameSocketClient {
  return io({
    autoConnect: false,
    withCredentials: true,
    transports: ['websocket', 'polling']
  }) as unknown as GameSocketClient;
}
