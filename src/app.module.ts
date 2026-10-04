import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule } from './database/database.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { EventsModule } from './events/events.module';
import { AccountModule } from './account/account.module';
import { AiModule } from './ai/ai.module';
import { RealtimeModule } from './realtime/realtime.module';
import { ChatModule } from './chat/chat.module';
import { SantaChatModule } from './santa-chat/santa-chat.module';
import { RATE_LIMITS } from './common/throttle/rate-limit';

// Root module. Feature modules (auth, users, events, …) get imported here
// as they are implemented.
@Module({
  imports: [
    // Storage for @RateLimit (in memory, per instance). No global guard: routes
    // opt in with a preset — see common/throttle/rate-limit.ts for why.
    ThrottlerModule.forRoot([{ name: 'default', ...RATE_LIMITS.preferences }]),
    DatabaseModule,
    UsersModule,
    AuthModule,
    EventsModule,
    AccountModule,
    AiModule,
    RealtimeModule,
    ChatModule,
    SantaChatModule,
  ],
})
export class AppModule {}
