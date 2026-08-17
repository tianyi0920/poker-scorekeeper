import {
  Body,
  Controller,
  Inject,
  Param,
  Post,
  Res,
  UseGuards
} from '@nestjs/common';
import {
  adjustLatestBuyinSchema,
  buyHandsSchema,
  canonicalPublicIdSchema,
  type AdjustLatestBuyinRequest,
  type BuyHandsRequest,
  type BuyinEventResponse
} from '@poker/contracts';
import type { AuthUser } from '../common/auth/auth-user.js';
import { CurrentUser } from '../common/auth/current-user.decorator.js';
import { SessionGuard } from '../common/auth/session.guard.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import { BuyinsService } from './buyins.service.js';

interface StatusResponse {
  statusCode: number;
}

@Controller('games/:gameId')
@UseGuards(SessionGuard)
export class BuyinsController {
  constructor(@Inject(BuyinsService) private readonly buyins: BuyinsService) {}

  @Post('buyins')
  async buy(
    @CurrentUser() actor: AuthUser,
    @Param('gameId', new ZodValidationPipe(canonicalPublicIdSchema)) gameId: string,
    @Body(new ZodValidationPipe(buyHandsSchema)) body: BuyHandsRequest,
    @Res({ passthrough: true }) response: StatusResponse
  ): Promise<BuyinEventResponse> {
    const result = await this.buyins.buy(gameId, actor, body);
    response.statusCode = result.replayed ? 200 : 201;
    return result;
  }

  @Post('players/:playerId/buyins/latest/adjust')
  async adjust(
    @CurrentUser() actor: AuthUser,
    @Param('gameId', new ZodValidationPipe(canonicalPublicIdSchema)) gameId: string,
    @Param('playerId', new ZodValidationPipe(canonicalPublicIdSchema)) playerId: string,
    @Body(new ZodValidationPipe(adjustLatestBuyinSchema)) body: AdjustLatestBuyinRequest,
    @Res({ passthrough: true }) response: StatusResponse
  ): Promise<BuyinEventResponse> {
    const result = await this.buyins.adjust(gameId, playerId, actor, body);
    response.statusCode = result.replayed ? 200 : 201;
    return result;
  }
}
