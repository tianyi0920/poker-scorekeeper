import { gameDeletedEventSchema } from '@poker/contracts';
import { useEffect, useRef } from 'react';
import { createGameSocket, type GameSocketClient, type GameSocketListener } from '../../api/game-socket.js';

export const GAME_DELETED_NOTICE = '该对局已由超级管理员删除';

export type GameDeletedSocketFactory = () => GameSocketClient;

export function useGameDeletedSubscription(
  gameId: string,
  onDeleted: () => void,
  socketFactory: GameDeletedSocketFactory = createGameSocket
): void {
  const onDeletedRef = useRef(onDeleted);
  onDeletedRef.current = onDeleted;

  useEffect(() => {
    if (gameId === '') return;

    const socket = socketFactory();
    let handled = false;
    const connect: GameSocketListener = () => {
      socket.emit('game.join', { gameId, knownVersion: 0 });
    };
    const receiveDeleted: GameSocketListener = (value) => {
      const parsed = gameDeletedEventSchema.safeParse(value);
      if (!parsed.success || parsed.data.gameId !== gameId || handled) return;
      handled = true;
      onDeletedRef.current();
    };

    socket.on('connect', connect);
    socket.on('game.deleted', receiveDeleted);
    socket.connect();

    return () => {
      if (socket.connected) socket.emit('game.leave', { gameId });
      socket.off('connect', connect);
      socket.off('game.deleted', receiveDeleted);
      socket.disconnect();
    };
  }, [gameId, socketFactory]);
}
