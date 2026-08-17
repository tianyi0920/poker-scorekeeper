import { Inject, Injectable } from '@nestjs/common';
import type { GameSpectatorSnapshotDto } from '@poker/contracts';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

type DatabaseClient = PrismaService | Prisma.TransactionClient;

function avatarUrl(kind: 'PRESET' | 'UPLOAD', value: string): string {
  return kind === 'PRESET' ? `/avatars/${value}.webp` : `/avatars/uploads/${value}`;
}

@Injectable()
export class PresenceService {
  private readonly rooms = new Map<string, Map<string, Set<string>>>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  add(gameId: string, userId: string, socketId: string): boolean {
    let users = this.rooms.get(gameId);
    if (users === undefined) {
      users = new Map();
      this.rooms.set(gameId, users);
    }
    let connections = users.get(userId);
    const firstConnection = connections === undefined;
    if (connections === undefined) {
      connections = new Set();
      users.set(userId, connections);
    }
    connections.add(socketId);
    return firstConnection;
  }

  hasConnection(gameId: string, userId: string, socketId: string): boolean {
    return this.rooms.get(gameId)?.get(userId)?.has(socketId) ?? false;
  }

  remove(gameId: string, userId: string, socketId: string): boolean {
    const users = this.rooms.get(gameId);
    const connections = users?.get(userId);
    if (users === undefined || connections === undefined) return false;
    connections.delete(socketId);
    if (connections.size > 0) return false;
    users.delete(userId);
    if (users.size === 0) this.rooms.delete(gameId);
    return true;
  }

  removeSocket(socketId: string): string[] {
    const changedGames: string[] = [];
    for (const [gameId, users] of this.rooms) {
      let changed = false;
      for (const [userId, connections] of users) {
        if (!connections.delete(socketId)) continue;
        if (connections.size === 0) {
          users.delete(userId);
          changed = true;
        }
      }
      if (users.size === 0) this.rooms.delete(gameId);
      if (changed) changedGames.push(gameId);
    }
    return changedGames;
  }

  async list(
    gameId: string,
    client: DatabaseClient = this.prisma
  ): Promise<GameSpectatorSnapshotDto[]> {
    const userIds = [...(this.rooms.get(gameId)?.keys() ?? [])];
    if (userIds.length === 0) return [];
    const [users, players] = await Promise.all([
      client.user.findMany({
        where: { id: { in: userIds }, isActive: true, deletedAt: null },
        select: { id: true, nickname: true, avatarKind: true, avatarValue: true }
      }),
      client.gamePlayer.findMany({
        where: { gameId, userId: { in: userIds } },
        select: { userId: true }
      })
    ]);
    const playerIds = new Set(players.map(({ userId }) => userId));
    return users
      .filter(({ id }) => !playerIds.has(id))
      .sort((left, right) => left.nickname.localeCompare(right.nickname, 'zh-CN') || left.id.localeCompare(right.id))
      .map((user) => ({
        userId: user.id,
        nickname: user.nickname,
        avatarUrl: avatarUrl(user.avatarKind, user.avatarValue)
      }));
  }
}
