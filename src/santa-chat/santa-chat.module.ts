import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SantaChatController } from './santa-chat.controller';
import { SantaChatService } from './santa-chat.service';

// The anonymous Secret Santa chat — /api/events/:id/santa-chat/:role and /api/santa-chats.
// Membership comes from EventsService, pairs from the draw, live delivery from the
// existing per-user realtime rooms (no second socket, no room per chat).
@Module({
  imports: [EventsModule, RealtimeModule],
  controllers: [SantaChatController],
  providers: [SantaChatService],
})
export class SantaChatModule {}
