import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SettlementDraftController } from './settlement-draft.controller.js';
import { SettlementDraftService } from './settlement-draft.service.js';

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [SettlementDraftController],
  providers: [SettlementDraftService],
  exports: [SettlementDraftService]
})
export class SettlementsModule {}
