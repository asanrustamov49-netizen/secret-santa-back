import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { type AiProviderName, env } from '../config/env';
import { EventsModule } from '../events/events.module';
import { UsersModule } from '../users/users.module';
import { AiContextService } from './ai-context.service';
import { AI_PROVIDER } from './ai-provider';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AnthropicProvider } from './providers/anthropic.provider';
import { GeminiProvider } from './providers/gemini.provider';

// The AI gift assistant — /api/ai/*
//   AiController      auth + validation, SSE transport
//   AiService         conversations, messages, one reply turn
//   AiContextService  "my recipient in this event", from EventsService's access-checked reads
//   AI_PROVIDER       the model, chosen by AI_PROVIDER in .env (Gemini by default)

const PROVIDERS = {
  gemini: { useClass: GeminiProvider, hasKey: () => !!env.geminiApiKey },
  anthropic: {
    useClass: AnthropicProvider,
    hasKey: () => !!env.anthropicApiKey,
  },
} satisfies Record<AiProviderName, unknown>;

@Module({
  imports: [EventsModule, UsersModule],
  controllers: [AiController],
  providers: [
    AiService,
    AiContextService,
    { provide: AI_PROVIDER, useClass: PROVIDERS[env.aiProvider].useClass },
  ],
})
export class AiModule implements OnModuleInit {
  onModuleInit() {
    // Which model answers, and whether it can — never the key itself
    const configured = PROVIDERS[env.aiProvider].hasKey();
    new Logger('AiModule').log(
      `AI provider: ${env.aiProvider}${configured ? '' : ' (no API key — the assistant answers "unavailable")'}`,
    );
  }
}
