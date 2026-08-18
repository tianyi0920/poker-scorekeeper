import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import type { HistoryResponseDto, SettlementDetailDto } from '@poker/contracts';
import type { AuthUser } from '../common/auth/auth-user.js';
import { CurrentUser } from '../common/auth/current-user.decorator.js';
import { RolesGuard } from '../common/auth/roles.guard.js';
import { SessionGuard } from '../common/auth/session.guard.js';
import { HistoryService } from './history.service.js';

@Controller('history')
@UseGuards(SessionGuard, RolesGuard)
export class HistoryController {
  constructor(@Inject(HistoryService) private readonly history: HistoryService) {}
  @Get() list(@CurrentUser() actor: AuthUser, @Query('limit') limit?: string, @Query('cursor') cursor?: string): Promise<HistoryResponseDto> { return this.history.list(actor, limit, cursor); }
  @Get(':gameId') get(@CurrentUser() actor: AuthUser, @Param('gameId') gameId: string): Promise<SettlementDetailDto> { return this.history.get(gameId, actor); }
}
