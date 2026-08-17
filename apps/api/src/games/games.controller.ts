import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards
} from '@nestjs/common';
import {
  createGameSchema,
  type CreateGameRequest,
  type CurrentGamesResponse,
  type GameSnapshotDto
} from '@poker/contracts';
import type { AuthUser } from '../common/auth/auth-user.js';
import { CurrentUser } from '../common/auth/current-user.decorator.js';
import { Roles } from '../common/auth/roles.decorator.js';
import { RolesGuard } from '../common/auth/roles.guard.js';
import { SessionGuard } from '../common/auth/session.guard.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import { Role } from '../generated/prisma/client.js';
import { GamesService } from './games.service.js';

@Controller('games')
@UseGuards(SessionGuard, RolesGuard)
export class GamesController {
  constructor(@Inject(GamesService) private readonly games: GamesService) {}

  @Post()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  create(
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(createGameSchema)) body: CreateGameRequest
  ): Promise<GameSnapshotDto> {
    return this.games.create(actor, body);
  }

  @Post(':id/start')
  @HttpCode(200)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  start(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<GameSnapshotDto> {
    return this.games.start(id, actor);
  }

  @Post(':id/begin-settlement')
  @HttpCode(200)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
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

  @Get(':id/snapshot')
  snapshot(@Param('id') id: string): Promise<GameSnapshotDto> {
    return this.games.snapshot(id);
  }
}
