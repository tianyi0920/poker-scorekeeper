import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards
} from '@nestjs/common';
import {
  createGameMessageRequestSchema,
  createGameSchema,
  type CreateGameMessageRequest,
  type CreateGameRequest,
  type CurrentGamesResponse,
  type GameMessageDto,
  type GameMessagesResponseDto,
  type GameSnapshotDto,
  type HardDeleteGameResponseDto,
  type ManagedGamesResponseDto
} from '@poker/contracts';
import type { AuthUser } from '../common/auth/auth-user.js';
import { CurrentUser } from '../common/auth/current-user.decorator.js';
import { Roles } from '../common/auth/roles.decorator.js';
import { RolesGuard } from '../common/auth/roles.guard.js';
import { SessionGuard } from '../common/auth/session.guard.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import { Role } from '../generated/prisma/client.js';
import {
  GameManagementService,
  type ManagementQuery,
  managementQuerySchema
} from './game-management.service.js';
import { GameMessagesService } from './game-messages.service.js';
import { GamesService } from './games.service.js';

interface LocationResponse {
  setHeader(name: 'Location', value: string): void;
}

@Controller('games')
@UseGuards(SessionGuard, RolesGuard)
export class GamesController {
  constructor(
    @Inject(GamesService) private readonly games: GamesService,
    @Inject(GameManagementService) private readonly gameManagement: GameManagementService,
    @Inject(GameMessagesService) private readonly gameMessages: GameMessagesService
  ) {}

  @Post()
  @Roles(Role.USER, Role.ADMIN, Role.SUPER_ADMIN)
  async create(
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(createGameSchema)) body: CreateGameRequest,
    @Res({ passthrough: true }) response: LocationResponse
  ): Promise<GameSnapshotDto> {
    const created = await this.games.create(actor, body);
    response.setHeader('Location', `/api/games/${created.id}`);
    return created;
  }

  @Post(':id/start')
  @HttpCode(200)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  start(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<GameSnapshotDto> {
    return this.games.start(id, actor);
  }

  @Post(':id/begin-settlement')
  @HttpCode(200)
  @Roles(Role.USER, Role.ADMIN, Role.SUPER_ADMIN)
  beginSettlement(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string
  ): Promise<GameSnapshotDto> {
    return this.games.beginSettlement(id, actor);
  }

  @Delete(':id/draft')
  @HttpCode(204)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  async deleteDraft(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<void> {
    await this.games.deleteDraft(id, actor);
  }

  @Delete(':id')
  @HttpCode(200)
  @Roles(Role.SUPER_ADMIN)
  hardDelete(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string
  ): Promise<HardDeleteGameResponseDto> {
    return this.gameManagement.hardDelete(id, actor);
  }

  @Post(':id/void')
  @HttpCode(200)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  void(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<GameSnapshotDto> {
    return this.games.void(id, actor);
  }

  @Get('current')
  current(): Promise<CurrentGamesResponse> {
    return this.games.current();
  }

  @Get('manage')
  @Roles(Role.SUPER_ADMIN)
  manage(
    @Query(new ZodValidationPipe(managementQuerySchema)) query: ManagementQuery
  ): Promise<ManagedGamesResponseDto> {
    return this.gameManagement.list(query);
  }

  @Get(':id/snapshot')
  snapshot(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string
  ): Promise<GameSnapshotDto> {
    return this.games.snapshot(id, actor);
  }

  @Get(':id/messages')
  messages(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string
  ): Promise<GameMessagesResponseDto> {
    return this.gameMessages.list(id, actor);
  }

  @Post(':id/messages')
  createMessage(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createGameMessageRequestSchema)) body: CreateGameMessageRequest
  ): Promise<GameMessageDto> {
    return this.gameMessages.create(id, actor, body);
  }
}
