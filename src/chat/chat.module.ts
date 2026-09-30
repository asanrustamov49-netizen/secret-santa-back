import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

// The event chat — /api/events/:id/messages. Membership comes from EventsService,
// live delivery from the existing realtime rooms (no second socket).
@Module({
  imports: [EventsModule, RealtimeModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
