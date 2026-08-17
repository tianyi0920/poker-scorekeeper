import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards
} from '@nestjs/common';
import {
  createUserSchema,
  resetUserPasswordSchema,
  updateUserSchema,
  type CreateUserRequest,
  type ResetUserPasswordRequest,
  type UpdateUserRequest,
  type UserResponse
} from '@poker/contracts';
import { CurrentUser } from '../common/auth/current-user.decorator.js';
import { Roles } from '../common/auth/roles.decorator.js';
import { RolesGuard } from '../common/auth/roles.guard.js';
import { SessionGuard } from '../common/auth/session.guard.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import { Role } from '../generated/prisma/client.js';
import { UsersService } from './users.service.js';

@Controller('users')
@UseGuards(SessionGuard, RolesGuard)
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get()
  list(): Promise<{ users: UserResponse[] }> {
    return this.users.list();
  }

  @Post()
  create(
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(createUserSchema)) body: CreateUserRequest
  ): Promise<UserResponse> {
    return this.users.create(actor, body);
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateUserSchema)) body: UpdateUserRequest
  ): Promise<UserResponse> {
    return this.users.update(actor, id, body);
  }

  @Delete(':id')
  softDelete(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string
  ): Promise<UserResponse> {
    return this.users.softDelete(actor, id);
  }

  @Post(':id/restore')
  @HttpCode(200)
  restore(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string
  ): Promise<UserResponse> {
    return this.users.restore(actor, id);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  resetPassword(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(resetUserPasswordSchema)) body: ResetUserPasswordRequest
  ): Promise<UserResponse> {
    return this.users.resetPassword(actor, id, body);
  }
}
