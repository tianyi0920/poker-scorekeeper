import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module.js';
import { AuditModule } from './audit/audit.module.js';
import { BuyinsModule } from './buyins/buyins.module.js';
import { SecurityModule } from './common/security/security.module.js';
import { HealthController } from './health/health.controller.js';
import { ReadinessController } from './health/readiness.controller.js';
import { GamesModule } from './games/games.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { SettlementsModule } from './settlements/settlements.module.js';
import { StaticModule } from './static/static.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SecurityModule,
    PrismaModule,
    AuditModule,
    AuthModule,
    RealtimeModule,
    BuyinsModule,
    GamesModule,
    UsersModule,
    SettingsModule,
    SettlementsModule,
    StaticModule
  ],
  controllers: [HealthController, ReadinessController]
})
export class AppModule {}
