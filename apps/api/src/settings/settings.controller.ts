import { Body, Controller, Get, Inject, Patch, UseGuards } from '@nestjs/common';
import {
  updateRakeSettingsSchema,
  type RakeSettingsDto,
  type UpdateRakeSettingsRequest
} from '@poker/contracts';
import type { AuthUser } from '../common/auth/auth-user.js';
import { CurrentUser } from '../common/auth/current-user.decorator.js';
import { Roles } from '../common/auth/roles.decorator.js';
import { RolesGuard } from '../common/auth/roles.guard.js';
import { SessionGuard } from '../common/auth/session.guard.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import { Role } from '../generated/prisma/client.js';
import { SettingsService } from './settings.service.js';

@Controller('settings')
@UseGuards(SessionGuard, RolesGuard)
export class SettingsController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  @Get('rake')
  getRake(): Promise<RakeSettingsDto> {
    return this.settings.getRake();
  }

  @Patch('rake')
  @Roles(Role.SUPER_ADMIN)
  updateRake(
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(updateRakeSettingsSchema)) body: UpdateRakeSettingsRequest
  ): Promise<RakeSettingsDto> {
    return this.settings.updateRake(actor, body);
  }
}
