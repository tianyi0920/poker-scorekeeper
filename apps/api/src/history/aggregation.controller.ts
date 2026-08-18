import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import type { AllPlayerAggregationDto } from '@poker/contracts';
import type { AuthUser } from '../common/auth/auth-user.js';
import { CurrentUser } from '../common/auth/current-user.decorator.js';
import { RolesGuard } from '../common/auth/roles.guard.js';
import { SessionGuard } from '../common/auth/session.guard.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import { AggregationService } from './aggregation.service.js';
import { historyAggregationRequestSchema, type HistoryAggregationRequest } from './history-filter.schema.js';

@Controller('history')
@UseGuards(SessionGuard, RolesGuard)
export class AggregationController {
  constructor(@Inject(AggregationService) private readonly aggregation: AggregationService) {}

  @Post('aggregate')
  @HttpCode(200)
  aggregate(
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(historyAggregationRequestSchema)) request: HistoryAggregationRequest
  ): Promise<AllPlayerAggregationDto> {
    return this.aggregation.aggregate(actor, request);
  }
}
