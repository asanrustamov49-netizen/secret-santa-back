import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import {
  type AiChatRequest,
  type AiProvider,
  AiProviderError,
} from '../ai-provider';

export const ANTHROPIC_MODEL = 'claude-sonnet-5';

const MAX_TOKENS = 16_000;

@Injectable()
export class AnthropicProvider implements AiProvider {
  private readonly logger = new Logger(AnthropicProvider.name);
  private client?: Anthropic;

  async *streamChat({
    system,
    messages,
    signal,
  }: AiChatRequest): AsyncIterable<string> {
    const stream = this.getClient().messages.stream(
      {
        model: ANTHROPIC_MODEL,
        max_tokens: MAX_TOKENS,
        output_config: { effort: 'medium' },
        system,
        messages,
      },
      { signal },
    );

    try {
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          yield event.delta.text;
        }
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') {
        throw new AiProviderError('refused');
      }
    } catch (error) {
      throw this.toProviderError(error);
    }
  }

  private getClient(): Anthropic {
    if (!env.anthropicApiKey) throw new AiProviderError('not_configured');
    this.client ??= new Anthropic({
      apiKey: env.anthropicApiKey,
      timeout: 60_000,
      maxRetries: 2, // the SDK retries 408/409/429/5xx and connection errors
    });
    return this.client;
  }

  private toProviderError(error: unknown): AiProviderError {
    if (error instanceof AiProviderError) return error;

    const failure = ((): AiProviderError['failure'] => {
      if (error instanceof Anthropic.APIUserAbortError) return 'aborted';
      if (error instanceof Anthropic.APIConnectionTimeoutError)
        return 'timeout';
      if (error instanceof Anthropic.APIConnectionError) return 'unavailable';
      if (error instanceof Anthropic.RateLimitError) return 'busy';
      if (
        error instanceof Anthropic.AuthenticationError ||
        error instanceof Anthropic.PermissionDeniedError
      )
        return 'not_configured';
      if (error instanceof Anthropic.BadRequestError) return 'invalid_request';
      return 'unavailable'; // 5xx, 529 overloaded, anything unexpected
    })();

    if (failure !== 'aborted') {
      const status =
        error instanceof Anthropic.APIError ? String(error.status) : '-';
      this.logger.warn(
        `Anthropic request failed: ${error instanceof Error ? error.constructor.name : 'unknown'} (status ${status}) → ${failure}`,
      );
    }
    return new AiProviderError(failure);
  }
}
