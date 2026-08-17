import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PasswordService } from '../auth/password.service.js';
import { AvatarController } from '../uploads/avatar.controller.js';
import { AvatarService } from '../uploads/avatar.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [AuthModule],
  controllers: [UsersController, AvatarController],
  providers: [PasswordService, UsersService, AvatarService],
  exports: [UsersService]
})
export class UsersModule {}
