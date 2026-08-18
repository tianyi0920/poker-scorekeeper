import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SettlementDraftController } from './settlement-draft.controller.js';
import { SettlementDraftService } from './settlement-draft.service.js';
import { SettlementFinalizationController } from './settlement-finalization.controller.js';
import { SettlementFinalizationService } from './settlement-finalization.service.js';

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [SettlementDraftController, SettlementFinalizationController],
  providers: [SettlementDraftService, SettlementFinalizationService],
  exports: [SettlementDraftService, SettlementFinalizationService]
})
export class SettlementsModule {}
