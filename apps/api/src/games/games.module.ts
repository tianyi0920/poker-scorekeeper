import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { GameManagementService } from './game-management.service.js';
import { GameMessagesService } from './game-messages.service.js';
import { GamesController } from './games.controller.js';
import { GamesService } from './games.service.js';

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [GamesController],
  providers: [GamesService, GameManagementService, GameMessagesService],
  exports: [GamesService]
})
export class GamesModule {}
