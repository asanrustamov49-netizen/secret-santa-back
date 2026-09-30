import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { UsersModule } from '../users/users.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { InvitesController, MatchesController } from './invites.controller';

// Events, invites, the draw and "who am I gifting" — /api/events, /api/invites, /api/matches
@Module({
  imports: [UsersModule, RealtimeModule],
  controllers: [EventsController, InvitesController, MatchesController],
  providers: [EventsService],
  // The AI assistant reads "my event, my match" through it instead of repeating those queries
  exports: [EventsService],
})
export class EventsModule {}
