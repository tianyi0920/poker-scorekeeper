import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { finalizeSettlementSchema, type FinalizeSettlementRequest, type SettlementDetailDto } from '@poker/contracts';
import type { AuthUser } from '../common/auth/auth-user.js';
import { CurrentUser } from '../common/auth/current-user.decorator.js';
import { Roles } from '../common/auth/roles.decorator.js';
import { RolesGuard } from '../common/auth/roles.guard.js';
import { SessionGuard } from '../common/auth/session.guard.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import { Role } from '../generated/prisma/client.js';
import { SettlementFinalizationService } from './settlement-finalization.service.js';

@Controller('games/:gameId')
@UseGuards(SessionGuard, RolesGuard)
export class SettlementFinalizationController {
  constructor(@Inject(SettlementFinalizationService) private readonly finalization: SettlementFinalizationService) {}

  @Post('settlement-finalize')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  finalize(
    @CurrentUser() actor: AuthUser,
    @Param('gameId') gameId: string,
    @Body(new ZodValidationPipe(finalizeSettlementSchema)) body: FinalizeSettlementRequest
  ): Promise<SettlementDetailDto> {
    return this.finalization.finalize(gameId, actor, body);
  }
}
