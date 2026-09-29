import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import {
  type AiChatRequest,
  type AiProvider,
  AiProviderError,
} from '../ai-provider';

/** Anthropic's recommended model for most workloads (models overview, checked 2026-09-27) */
export const ANTHROPIC_MODEL = 'claude-sonnet-5';

/** Gift ideas are short; room for the model's thinking plus a full answer */
const MAX_TOKENS = 16_000;

/** Claude through the official SDK, streamed */
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
        // Thinking is always on for this model; medium effort (its default, set
        // explicitly) keeps a chat reply quick
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

  /** Created on first use, so the app starts without a key */
  private getClient(): Anthropic {
    if (!env.anthropicApiKey) throw new AiProviderError('not_configured');
    // The key is passed explicitly: never pick up a developer's local CLI login by accident
    this.client ??= new Anthropic({
      apiKey: env.anthropicApiKey,
      timeout: 60_000,
      maxRetries: 2, // the SDK retries 408/409/429/5xx and connection errors
    });
    return this.client;
  }

  /** SDK errors → AiFailure. Logged by class and status only: no key, no prompt, no user text. */
  private toProviderError(error: unknown): AiProviderError {
    if (error instanceof AiProviderError) return error;

    const failure = ((): AiProviderError['failure'] => {
      // Most specific first: timeout ⊂ connection ⊂ APIError
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
