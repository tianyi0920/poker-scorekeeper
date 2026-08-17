import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module.js';
import { AuditModule } from './audit/audit.module.js';
import { BuyinsModule } from './buyins/buyins.module.js';
import { HealthController } from './health/health.controller.js';
import { GamesModule } from './games/games.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuditModule,
    AuthModule,
    BuyinsModule,
    GamesModule,
    UsersModule,
    SettingsModule
  ],
  controllers: [HealthController]
})
export class AppModule {}
