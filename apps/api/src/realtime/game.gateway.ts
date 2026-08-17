import { Inject } from '@nestjs/common';
import {
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
import { AppError } from '../common/errors/app-error.js';
import { GameEventsService } from './game-events.service.js';
import { PresenceService } from './presence.service.js';
import { SocketSessionAdapter, type GameSocket } from './socket-session.adapter.js';

function roomName(gameId: string): string {
  return `game:${gameId}`;
}

function errorCode(error: unknown): 'FORBIDDEN' | 'NOT_FOUND' | 'INTERNAL_ERROR' {
  return error instanceof AppError && (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')
    ? error.code
    : 'INTERNAL_ERROR';
}

@WebSocketGateway()
export class GameGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server!: Server;

  constructor(
    @Inject(SocketSessionAdapter) private readonly socketSessions: SocketSessionAdapter,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(GameEventsService) private readonly events: GameEventsService
  ) {}

  afterInit(server: Server): void {
    this.events.bindServer(server);
    server.use(async (untypedSocket, next) => {
      const socket = untypedSocket as GameSocket;
      try {
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
    @MessageBody() payload: unknown
  ): Promise<GameJoinAck> {
    const parsed = gameJoinCommandSchema.safeParse(payload);
    if (!parsed.success) return this.fail(socket, 'VALIDATION_ERROR');
    const authSession = await this.socketSessions.revalidate(socket);
    if (authSession === null) return { ok: false, code: 'UNAUTHENTICATED' };

    try {
      await this.events.snapshotFor(authSession.user, parsed.data.gameId);
      const previousGameId = socket.data.gameId;
      if (previousGameId !== undefined && previousGameId !== parsed.data.gameId) {
        await socket.leave(roomName(previousGameId));
        this.presence.remove(previousGameId, authSession.user.id, socket.id);
        await this.events.publishPresence(previousGameId);
      }
      await socket.join(roomName(parsed.data.gameId));
      this.presence.add(parsed.data.gameId, authSession.user.id, socket.id);
      socket.data.gameId = parsed.data.gameId;

      const snapshot = await this.events.snapshotFor(authSession.user, parsed.data.gameId);
      const snapshotSent = parsed.data.knownVersion !== snapshot.version;
      if (snapshotSent) socket.emit('game.snapshot', snapshot);
      await this.events.publishPresence(parsed.data.gameId);
      return {
        ok: true,
        gameId: parsed.data.gameId,
        version: snapshot.version,
        snapshotSent
      };
    } catch (error) {
      return this.fail(socket, errorCode(error));
    }
  }

  @SubscribeMessage('game.leave')
  async leave(
    @ConnectedSocket() socket: GameSocket,
    @MessageBody() payload: unknown
  ): Promise<GameLeaveAck> {
    const parsed = gameLeaveCommandSchema.safeParse(payload);
    if (!parsed.success) return this.fail(socket, 'VALIDATION_ERROR');
    const authSession = await this.socketSessions.revalidate(socket);
    if (authSession === null) return { ok: false, code: 'UNAUTHENTICATED' };
    await socket.leave(roomName(parsed.data.gameId));
    this.presence.remove(parsed.data.gameId, authSession.user.id, socket.id);
    if (socket.data.gameId === parsed.data.gameId) delete socket.data.gameId;
    await this.events.publishPresence(parsed.data.gameId);
    return { ok: true, gameId: parsed.data.gameId };
  }

  private fail<T extends 'UNAUTHENTICATED' | 'FORBIDDEN' | 'VALIDATION_ERROR' | 'NOT_FOUND' | 'INTERNAL_ERROR'>(
    socket: GameSocket,
    code: T
  ): { ok: false; code: T } {
    socket.emit('server.error', { code });
    return { ok: false, code };
  }
}
