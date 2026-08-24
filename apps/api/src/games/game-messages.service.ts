import { Inject, Injectable } from '@nestjs/common';
import {
  createGameMessageRequestSchema,
  type CreateGameMessageRequest,
  type GameMessageDto,
  type GameMessagesResponseDto
} from '@poker/contracts';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../common/auth/auth-user.js';
import { conflict, notFound } from '../common/errors/app-error.js';
import { GameStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GameEventsService } from '../realtime/game-events.service.js';
import { assertCanViewGameSnapshot } from './game-policy.js';

const MAX_MESSAGES_PER_GAME = 50;

@Injectable()
export class GameMessagesService {
  private readonly messagesByGame = new Map<string, GameMessageDto[]>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GameEventsService) private readonly events: GameEventsService
  ) {}

  async list(gameId: string, actor: AuthUser): Promise<GameMessagesResponseDto> {
    const game = await this.authorizedGame(gameId, actor);
    return {
      gameId,
      messages: game.status === GameStatus.ACTIVE
        ? [...(this.messagesByGame.get(gameId) ?? [])]
        : []
    };
  }

  async create(
    gameId: string,
    actor: AuthUser,
    input: CreateGameMessageRequest
  ): Promise<GameMessageDto> {
    const game = await this.authorizedGame(gameId, actor);
    if (game.status !== GameStatus.ACTIVE) throw conflict('GAME_STATE_CONFLICT');
    const parsed = createGameMessageRequestSchema.parse(input);
    const message: GameMessageDto = {
      id: randomUUID(),
      gameId,
      userId: actor.id,
      nickname: actor.nickname,
      avatarUrl: actor.avatarKind === 'PRESET'
        ? `/avatars/${actor.avatarValue}.webp`
        : `/avatars/uploads/${actor.avatarValue}`,
      text: parsed.text,
      createdAt: new Date().toISOString()
    };
    const messages = [...(this.messagesByGame.get(gameId) ?? []), message]
      .slice(-MAX_MESSAGES_PER_GAME);
    this.messagesByGame.set(gameId, messages);
    await this.events.publishGameMessage(gameId, message).catch(() => undefined);
    return message;
  }

  clear(gameId: string): void {
    this.messagesByGame.delete(gameId);
  }

  private async authorizedGame(gameId: string, actor: AuthUser) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      select: {
        id: true,
        status: true,
        players: { select: { userId: true } }
      }
    });
    if (game === null) throw notFound('NOT_FOUND');
    assertCanViewGameSnapshot(actor, game);
    return game;
  }
}
