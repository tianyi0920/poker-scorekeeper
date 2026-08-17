import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { GameEventsService } from './game-events.service.js';
import { GameGateway } from './game.gateway.js';
import { PresenceService } from './presence.service.js';
import { SocketSessionAdapter } from './socket-session.adapter.js';

@Global()
@Module({
  imports: [AuthModule],
  providers: [PresenceService, SocketSessionAdapter, GameEventsService, GameGateway],
  exports: [PresenceService, SocketSessionAdapter, GameEventsService]
})
export class RealtimeModule {}
