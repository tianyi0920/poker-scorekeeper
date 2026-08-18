import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AggregationController } from './aggregation.controller.js';
import { AggregationService } from './aggregation.service.js';
import { HistoryController } from './history.controller.js';
import { HistoryService } from './history.service.js';
@Module({
  imports: [AuthModule],
  controllers: [HistoryController, AggregationController],
  providers: [HistoryService, AggregationService]
})
export class HistoryModule {}
