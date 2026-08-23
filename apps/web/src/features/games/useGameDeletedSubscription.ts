import { gameDeletedEventSchema, gameJoinAckSchema, serverErrorEventSchema } from '@poker/contracts';
import { useCallback, useEffect, useRef } from 'react';
import { createGameSocket, type GameSocketClient, type GameSocketListener } from '../../api/game-socket.js';

export const GAME_DELETED_NOTICE = '该对局已由超级管理员删除';

export type GameDeletedSocketFactory = () => GameSocketClient;

interface DeletionEvidenceState {
  gameId: string;
  knownGameExists: boolean;
  pendingNotFound: boolean;
  handled: boolean;
}

export function useGameDeletedSubscription(
  gameId: string,
  onDeleted: () => void,
  socketFactory: GameDeletedSocketFactory = createGameSocket,
  knownGameExists = false
): void {
  const onDeletedRef = useRef(onDeleted);
  onDeletedRef.current = onDeleted;
  const evidenceRef = useRef<DeletionEvidenceState>({ gameId, knownGameExists: false, pendingNotFound: false, handled: false });
  if (evidenceRef.current.gameId !== gameId) {
    evidenceRef.current = { gameId, knownGameExists: false, pendingNotFound: false, handled: false };
  }

  const triggerDeleted = useCallback(() => {
    const evidence = evidenceRef.current;
    if (evidence.gameId !== gameId || evidence.handled) return;
    evidence.handled = true;
    onDeletedRef.current();
  }, [gameId]);

  const confirmExists = useCallback(() => {
    const evidence = evidenceRef.current;
    if (evidence.gameId !== gameId || evidence.handled) return;
    evidence.knownGameExists = true;
    if (evidence.pendingNotFound) triggerDeleted();
  }, [gameId, triggerDeleted]);

  const receiveNotFound = useCallback(() => {
    const evidence = evidenceRef.current;
    if (evidence.gameId !== gameId || evidence.handled) return;
    evidence.pendingNotFound = true;
    if (evidence.knownGameExists) triggerDeleted();
  }, [gameId, triggerDeleted]);

  useEffect(() => {
    if (knownGameExists) confirmExists();
  }, [confirmExists, knownGameExists]);

  useEffect(() => {
    if (gameId === '') return;

    const socket = socketFactory();
    const connect: GameSocketListener = () => {
      socket.emit('game.join', { gameId, knownVersion: 0 }, (value) => {
        const acknowledgement = gameJoinAckSchema.safeParse(value);
        if (!acknowledgement.success) return;
        if (acknowledgement.data.ok) {
          if (acknowledgement.data.gameId === gameId) confirmExists();
          return;
        }
        if (acknowledgement.data.code === 'NOT_FOUND') receiveNotFound();
      });
    };
    const receiveDeleted: GameSocketListener = (value) => {
      const parsed = gameDeletedEventSchema.safeParse(value);
      if (!parsed.success || parsed.data.gameId !== gameId) return;
      triggerDeleted();
    };
    const receiveServerError: GameSocketListener = (value) => {
      const parsed = serverErrorEventSchema.safeParse(value);
      if (parsed.success && parsed.data.code === 'NOT_FOUND') receiveNotFound();
    };

    socket.on('connect', connect);
    socket.on('game.deleted', receiveDeleted);
    socket.on('server.error', receiveServerError);
    socket.connect();

    return () => {
      if (socket.connected) socket.emit('game.leave', { gameId });
      socket.off('connect', connect);
      socket.off('game.deleted', receiveDeleted);
      socket.off('server.error', receiveServerError);
      socket.disconnect();
    };
  }, [confirmExists, gameId, receiveNotFound, socketFactory, triggerDeleted]);
}
