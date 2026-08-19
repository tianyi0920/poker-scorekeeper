import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module.js';
import { AuditModule } from './audit/audit.module.js';
import { BuyinsModule } from './buyins/buyins.module.js';
import { SecurityModule } from './common/security/security.module.js';
import { HealthController } from './health/health.controller.js';
import {
  DEPLOYMENT_ID_READER,
  DeploymentIdentityController,
  readDeploymentId
} from './health/deployment-identity.controller.js';
import { ReadinessController } from './health/readiness.controller.js';
import {
  MariaDbReadinessProbe,
  READINESS_CONNECTION_FACTORY,
  mariaDbReadinessConnectionFactory
} from './health/mariadb-readiness.probe.js';
import { GamesModule } from './games/games.module.js';
import { HistoryModule } from './history/history.module.js';
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
    HistoryModule,
    UsersModule,
    SettingsModule,
    SettlementsModule,
    StaticModule
  ],
  controllers: [HealthController, ReadinessController, DeploymentIdentityController],
  providers: [
    MariaDbReadinessProbe,
    {
      provide: DEPLOYMENT_ID_READER,
      useValue: () => readDeploymentId()
    },
    {
      provide: READINESS_CONNECTION_FACTORY,
      useValue: mariaDbReadinessConnectionFactory
    }
  ]
})
export class AppModule {}
