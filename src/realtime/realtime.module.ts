import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RealtimeTicketService } from './realtime-ticket.service';
import { RealtimeController } from './realtime.controller';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

// Live updates over Socket.IO — a notification channel next to the REST API, which
// stays the source of truth:
//   RealtimeController     GET /api/realtime/ticket — a pass for the socket handshake
//   RealtimeGateway        handshake auth, user/event rooms, join with membership check
//   RealtimeService        "event X changed" to the right rooms (used by feature controllers)
// Connections are runtime state only: nothing is stored in the database.
@Module({
  imports: [JwtModule.register({})],
  controllers: [RealtimeController],
  providers: [RealtimeService, RealtimeTicketService, RealtimeGateway],
  exports: [RealtimeService],
})
export class RealtimeModule {}
