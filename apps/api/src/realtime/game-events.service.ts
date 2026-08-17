import { Inject, Injectable } from '@nestjs/common';
import type { GameSnapshotDto, PresenceUpdatedEvent } from '@poker/contracts';
import type { Server } from 'socket.io';
import type { AuthUser } from '../common/auth/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { GameStatus, Prisma } from '../generated/prisma/client.js';
import { assertCanViewGameSnapshot } from '../games/game-policy.js';
import { mapGameSnapshot, type SnapshotGameRecord } from '../games/game-snapshot.mapper.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PresenceService } from './presence.service.js';
import { SocketSessionAdapter, type GameSocket } from './socket-session.adapter.js';

const snapshotInclude = {
  players: true,
  buyinEvents: { include: { actorUser: { select: { nickname: true } } } }
} satisfies Prisma.GameInclude;

const OPEN_STATUSES = [GameStatus.ACTIVE, GameStatus.SETTLING] as const;

function roomName(gameId: string): string {
  return `game:${gameId}`;
}

@Injectable()
export class GameEventsService {
  private server?: Server;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(SocketSessionAdapter) private readonly socketSessions: SocketSessionAdapter
  ) {}

  bindServer(server: Server): void {
    this.server = server;
  }

  async snapshotFor(actor: AuthUser, gameId: string): Promise<GameSnapshotDto> {
    const game = await this.prisma.game.findUnique({ where: { id: gameId }, include: snapshotInclude });
    if (game === null) throw new AppError(404, 'NOT_FOUND');
    assertCanViewGameSnapshot(actor, game);
    return mapGameSnapshot(
      game as SnapshotGameRecord,
      new Date(),
      await this.presence.list(gameId)
    );
  }

  async publishCommittedGame(gameId: string): Promise<void> {
    const game = await this.prisma.game.findUnique({ where: { id: gameId }, include: snapshotInclude });
    if (game === null) return;
    const spectators = await this.presence.list(gameId);
    const snapshot = mapGameSnapshot(game as SnapshotGameRecord, new Date(), spectators);
    await this.forEachAuthorizedSocket(gameId, game, (socket) => {
      socket.emit('game.updated', snapshot);
    });
    await this.publishPresence(gameId);
  }

  async publishPresence(gameId: string): Promise<void> {
    const game = await this.prisma.game.findUnique({ where: { id: gameId }, include: snapshotInclude });
    if (game === null) return;
    const event: PresenceUpdatedEvent = {
      gameId,
      spectators: await this.presence.list(gameId)
    };
    await this.forEachAuthorizedSocket(gameId, game, (socket) => {
      socket.emit('presence.updated', event);
    });
  }

  async publishRakeSettings(version: number): Promise<void> {
    const games = await this.prisma.game.findMany({
      where: { status: { in: [...OPEN_STATUSES] } },
      include: snapshotInclude
    });
    for (const game of games) {
      await this.forEachAuthorizedSocket(game.id, game, (socket) => {
        socket.emit('rake-settings.updated', { version });
      });
    }
  }

  async publishPlayerRake(userId: string): Promise<void> {
    const activeLock = await this.prisma.activePlayerLock.findUnique({
      where: { userId },
      include: { game: { include: snapshotInclude } }
    });
    if (activeLock === null) return;
    await this.forEachAuthorizedSocket(activeLock.gameId, activeLock.game, (socket) => {
      socket.emit('player-rake.updated', { userId });
    });
  }

  private async forEachAuthorizedSocket(
    gameId: string,
    game: SnapshotGameRecord,
    emit: (socket: GameSocket) => void
  ): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    const socketIds = server.sockets.adapter.rooms.get(roomName(gameId));
    if (socketIds === undefined) return;
    for (const socketId of [...socketIds]) {
      const socket = server.sockets.sockets.get(socketId) as GameSocket | undefined;
      if (socket === undefined) continue;
      const authSession = await this.socketSessions.revalidate(socket);
      if (authSession === null) {
        socket.disconnect(true);
        continue;
      }
      try {
        assertCanViewGameSnapshot(authSession.user, game);
        emit(socket);
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
        socket.emit('server.error', { code });
        await socket.leave(roomName(gameId));
        this.presence.remove(gameId, authSession.user.id, socket.id);
        if (socket.data.gameId === gameId) delete socket.data.gameId;
      }
    }
  }
}
