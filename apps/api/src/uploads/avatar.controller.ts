import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  selectPresetAvatarSchema,
  type SelectPresetAvatarRequest
} from '@poker/contracts';
import { CurrentUser } from '../common/auth/current-user.decorator.js';
import { Roles } from '../common/auth/roles.decorator.js';
import { RolesGuard } from '../common/auth/roles.guard.js';
import { SessionGuard } from '../common/auth/session.guard.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import { Role } from '../generated/prisma/client.js';
import {
  AvatarService,
  MAX_AVATAR_BYTES,
  type AvatarResponse,
  type UploadedAvatarFile
} from './avatar.service.js';
import { PRESET_AVATARS, type PresetAvatar } from './preset-avatars.js';

@Controller()
export class AvatarController {
  constructor(@Inject(AvatarService) private readonly avatars: AvatarService) {}

  @Get('avatars/presets')
  @UseGuards(SessionGuard)
  presets(): { presets: readonly PresetAvatar[] } {
    return { presets: PRESET_AVATARS };
  }

  @Put('me/avatar/preset')
  @UseGuards(SessionGuard)
  selectPreset(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(selectPresetAvatarSchema)) body: SelectPresetAvatarRequest
  ): Promise<AvatarResponse> {
    return this.avatars.selectPreset(user.id, body.presetId);
  }

  @Post('me/avatar/upload')
  @UseGuards(SessionGuard)
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: MAX_AVATAR_BYTES, files: 1 }
  }))
  upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadedAvatarFile | undefined
  ): Promise<AvatarResponse> {
    return this.avatars.upload(user.id, file);
  }

  @Post('users/:id/avatar/reset')
  @HttpCode(200)
  @UseGuards(SessionGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  resetByAdministrator(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string
  ): Promise<AvatarResponse> {
    return this.avatars.resetByAdministrator(actor, id);
  }
}
