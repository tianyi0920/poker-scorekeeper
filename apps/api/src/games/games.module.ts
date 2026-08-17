import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { GamesController } from './games.controller.js';
import { GamesService } from './games.service.js';

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [GamesController],
  providers: [GamesService],
  exports: [GamesService]
})
export class GamesModule {}
