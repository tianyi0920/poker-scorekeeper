import { Inject } from '@nestjs/common';
import {
  Ack,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer
} from '@nestjs/websockets';
import {
  gameJoinCommandSchema,
  gameLeaveCommandSchema,
  type GameJoinAck,
  type GameLeaveAck
} from '@poker/contracts';
import type { Server } from 'socket.io';
import type { AuthenticatedSession } from '../common/auth/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { GameEventsService } from './game-events.service.js';
import { PresenceService } from './presence.service.js';
import { SocketSessionAdapter, type GameSocket } from './socket-session.adapter.js';
import { WebSocketOriginPolicy } from './websocket-origin.policy.js';

type FailureAck = Extract<GameJoinAck, { ok: false }>;
type CommandErrorCode = FailureAck['code'];
type SocketAck<T> = ((response: T) => void) | undefined;

interface PreviousRoomState {
  gameId: string;
  joined: boolean;
  present: boolean;
}

class RealtimeCommandError extends Error {
  constructor(readonly code: CommandErrorCode) {
    super(code);
  }
}

function roomName(gameId: string): string {
  return `game:${gameId}`;
}

function errorCode(error: unknown): CommandErrorCode {
  if (error instanceof RealtimeCommandError) return error.code;
  return error instanceof AppError && (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')
    ? error.code
    : 'INTERNAL_ERROR';
}

@WebSocketGateway({ maxHttpBufferSize: 64 * 1024 })
export class GameGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server!: Server;

  constructor(
    @Inject(SocketSessionAdapter) private readonly socketSessions: SocketSessionAdapter,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(GameEventsService) private readonly events: GameEventsService,
    @Inject(WebSocketOriginPolicy) private readonly origins: WebSocketOriginPolicy
  ) {}

  afterInit(server: Server): void {
    this.events.bindServer(server);
    server.use(async (untypedSocket, next) => {
      const socket = untypedSocket as GameSocket;
      try {
        if (!this.origins.allows(socket.handshake.headers.origin)) {
          next(new Error('FORBIDDEN'));
          return;
        }
        if (!await this.socketSessions.authenticateHandshake(socket)) {
          next(new Error('UNAUTHENTICATED'));
          return;
        }
        next();
      } catch {
        next(new Error('UNAUTHENTICATED'));
      }
    });
  }

  handleConnection(socket: GameSocket): void {
    this.socketSessions.register(socket);
  }

  handleDisconnect(socket: GameSocket): void {
    this.socketSessions.unregister(socket);
    const changedGames = this.presence.removeSocket(socket.id);
    for (const gameId of changedGames) void this.events.publishPresence(gameId).catch(() => undefined);
  }

  @SubscribeMessage('game.join')
  async join(
    @ConnectedSocket() socket: GameSocket,
    @MessageBody() payload: unknown,
    @Ack() acknowledge?: SocketAck<GameJoinAck>
  ): Promise<void> {
    const response = await this.executeCommand(socket, async (authSession) => {
      const parsed = gameJoinCommandSchema.safeParse(payload);
      if (!parsed.success) throw new RealtimeCommandError('VALIDATION_ERROR');
      const targetGameId = parsed.data.gameId;
      const previousGameId = socket.data.gameId;
      const previousState = previousGameId === undefined ? undefined : {
        gameId: previousGameId,
        joined: socket.rooms.has(roomName(previousGameId)),
        present: this.presence.hasConnection(previousGameId, authSession.user.id, socket.id)
      };
      const authorizedSnapshot = await this.events.snapshotFor(authSession.user, targetGameId);

      if (previousGameId === targetGameId) {
        await this.events.publishPresence(targetGameId);
        const snapshotSent = parsed.data.knownVersion !== authorizedSnapshot.version;
        if (snapshotSent) socket.emit('game.snapshot', authorizedSnapshot);
        return {
          ok: true,
          gameId: targetGameId,
          version: authorizedSnapshot.version,
          snapshotSent
        } as const;
      }

      try {
        await socket.join(roomName(targetGameId));
        this.presence.add(targetGameId, authSession.user.id, socket.id);
        const snapshot = await this.events.snapshotFor(authSession.user, targetGameId);
        await this.events.publishPresence(targetGameId);

        if (previousGameId !== undefined) {
          await socket.leave(roomName(previousGameId));
          this.presence.remove(previousGameId, authSession.user.id, socket.id);
          await this.events.publishPresence(previousGameId);
        }

        socket.data.gameId = targetGameId;
        const snapshotSent = parsed.data.knownVersion !== snapshot.version;
        if (snapshotSent) socket.emit('game.snapshot', snapshot);
        return {
          ok: true,
          gameId: targetGameId,
          version: snapshot.version,
          snapshotSent
        } as const;
      } catch (error) {
        await this.rollbackJoin(socket, authSession.user.id, previousState, targetGameId);
        throw error;
      }
    });

    this.deliverAck(socket, acknowledge, response);
  }

  @SubscribeMessage('game.leave')
  async leave(
    @ConnectedSocket() socket: GameSocket,
    @MessageBody() payload: unknown,
    @Ack() acknowledge?: SocketAck<GameLeaveAck>
  ): Promise<void> {
    const response = await this.executeCommand(socket, async (authSession) => {
      const parsed = gameLeaveCommandSchema.safeParse(payload);
      if (!parsed.success) throw new RealtimeCommandError('VALIDATION_ERROR');
      const gameId = parsed.data.gameId;
      if (socket.data.gameId !== gameId) return { ok: true, gameId } as const;
      const previousState: PreviousRoomState = {
        gameId,
        joined: socket.rooms.has(roomName(gameId)),
        present: this.presence.hasConnection(gameId, authSession.user.id, socket.id)
      };

      try {
        await socket.leave(roomName(gameId));
        this.presence.remove(gameId, authSession.user.id, socket.id);
        await this.events.publishPresence(gameId);
        delete socket.data.gameId;
        return { ok: true, gameId } as const;
      } catch (error) {
        await this.restoreRoom(socket, authSession.user.id, previousState);
        throw error;
      }
    });

    this.deliverAck(socket, acknowledge, response);
  }

  private async executeCommand<T extends { ok: true }>(
    socket: GameSocket,
    operation: (authSession: AuthenticatedSession) => Promise<T>
  ): Promise<T | FailureAck> {
    try {
      const authSession = await this.socketSessions.revalidate(socket);
      if (authSession === null) throw new RealtimeCommandError('UNAUTHENTICATED');
      return await operation(authSession);
    } catch (error) {
      const code = errorCode(error);
      socket.emit('server.error', { code });
      return { ok: false, code };
    }
  }

  private deliverAck<T extends GameJoinAck | GameLeaveAck>(
    socket: GameSocket,
    acknowledge: SocketAck<T>,
    response: T
  ): void {
    acknowledge?.(response);
    if (!response.ok && response.code === 'UNAUTHENTICATED') {
      const timer = setTimeout(() => socket.disconnect(true), 25);
      timer.unref();
    }
  }

  private async rollbackJoin(
    socket: GameSocket,
    userId: string,
    previousState: PreviousRoomState | undefined,
    targetGameId: string
  ): Promise<void> {
    try {
      await socket.leave(roomName(targetGameId));
    } catch {
      // Continue restoring the remaining independent state.
    }
    try {
      this.presence.remove(targetGameId, userId, socket.id);
    } catch {
      // Continue restoring the remaining independent state.
    }

    if (previousState === undefined) {
      delete socket.data.gameId;
    } else {
      await this.restoreRoom(socket, userId, previousState, false);
    }
    await this.publishFinalPresence(previousState?.gameId, targetGameId);
  }

  private async restoreRoom(
    socket: GameSocket,
    userId: string,
    previousState: PreviousRoomState,
    publish = true
  ): Promise<void> {
    if (previousState.joined) {
      try {
        await socket.join(roomName(previousState.gameId));
      } catch {
        // A later reconnect still recovers from the database snapshot.
      }
    }
    if (previousState.present) {
      try {
        this.presence.add(previousState.gameId, userId, socket.id);
      } catch {
        // Presence is non-financial, in-memory state and disconnect cleanup remains safe.
      }
    }
    socket.data.gameId = previousState.gameId;
    if (publish) await this.publishFinalPresence(previousState.gameId);
  }

  private async publishFinalPresence(...gameIds: Array<string | undefined>): Promise<void> {
    const uniqueGameIds = [...new Set(gameIds.filter((gameId): gameId is string => gameId !== undefined))];
    await Promise.allSettled(uniqueGameIds.map((gameId) => this.events.publishPresence(gameId)));
  }
}
