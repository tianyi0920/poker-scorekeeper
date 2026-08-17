import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  UseGuards
} from '@nestjs/common';
import {
  saveSettlementDraftSchema,
  settlementPreviewRequestSchema,
  type SaveSettlementDraftRequest,
  type SettlementDraftDto,
  type SettlementDraftPayload,
  type SettlementPreviewDto
} from '@poker/contracts';
import type { AuthUser } from '../common/auth/auth-user.js';
import { CurrentUser } from '../common/auth/current-user.decorator.js';
import { Roles } from '../common/auth/roles.decorator.js';
import { RolesGuard } from '../common/auth/roles.guard.js';
import { SessionGuard } from '../common/auth/session.guard.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import { Role } from '../generated/prisma/client.js';
import { SettlementDraftService } from './settlement-draft.service.js';

@Controller('games/:gameId')
@UseGuards(SessionGuard, RolesGuard)
export class SettlementDraftController {
  constructor(@Inject(SettlementDraftService) private readonly drafts: SettlementDraftService) {}

  @Get('settlement-draft')
  get(
    @CurrentUser() actor: AuthUser,
    @Param('gameId') gameId: string
  ): Promise<SettlementDraftDto> {
    return this.drafts.get(gameId, actor);
  }

  @Put('settlement-draft')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  save(
    @CurrentUser() actor: AuthUser,
    @Param('gameId') gameId: string,
    @Body(new ZodValidationPipe(saveSettlementDraftSchema)) body: SaveSettlementDraftRequest
  ): Promise<SettlementDraftDto> {
    return this.drafts.save(gameId, actor, body);
  }

  @Post('settlement-draft/takeover')
  @HttpCode(200)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  takeover(
    @CurrentUser() actor: AuthUser,
    @Param('gameId') gameId: string
  ): Promise<SettlementDraftDto> {
    return this.drafts.takeover(gameId, actor);
  }

  @Post('settlement-preview')
  @HttpCode(200)
  preview(
    @CurrentUser() actor: AuthUser,
    @Param('gameId') gameId: string,
    @Body(new ZodValidationPipe(settlementPreviewRequestSchema)) body: SettlementDraftPayload
  ): Promise<SettlementPreviewDto> {
    return this.drafts.preview(gameId, actor, body);
  }
}
