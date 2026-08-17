import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { BuyinsController } from './buyins.controller.js';
import { BuyinsService } from './buyins.service.js';

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [BuyinsController],
  providers: [BuyinsService],
  exports: [BuyinsService]
})
export class BuyinsModule {}
