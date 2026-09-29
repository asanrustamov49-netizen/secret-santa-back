import { Injectable, Logger } from '@nestjs/common';
import {
  ApiError,
  type Content,
  FinishReason,
  type GenerateContentResponse,
  GoogleGenAI,
  ThinkingLevel,
} from '@google/genai';
import { env } from '../../config/env';
import {
  type AiChatRequest,
  type AiProvider,
  AiProviderError,
  type AiTurn,
} from '../ai-provider';

/** Google's recommended default model, on the free tier (models overview + pricing, checked 2026-09-28) */
export const GEMINI_MODEL = 'gemini-3.8-flash';

/** Gift ideas are short; room for the model's thinking plus a full answer */
const MAX_OUTPUT_TOKENS = 16_000;

/** The model stopped because of its safety rules: the user sees "can't help with that" */
const REFUSALS = new Set<FinishReason>([
  FinishReason.SAFETY,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.BLOCKLIST,
  FinishReason.SPII,
]);

/** Gemini through the official Google Gen AI SDK (@google/genai), streamed */
@Injectable()
export class GeminiProvider implements AiProvider {
  private readonly logger = new Logger(GeminiProvider.name);
  private client?: GoogleGenAI;

  async *streamChat({
    system,
    messages,
    signal,
  }: AiChatRequest): AsyncIterable<string> {
    try {
      const stream = await this.getClient().models.generateContentStream({
        model: GEMINI_MODEL,
        contents: messages.map(toContent),
        config: {
          systemInstruction: system,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          // Low thinking keeps a chat reply quick; gift ideas don't need deep reasoning
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          abortSignal: signal,
        },
      });
      for await (const chunk of stream) {
        yield* textOf(chunk);
      }
    } catch (error) {
      throw this.toProviderError(error, signal);
    }
  }

  /** Created on first use, so the app starts without a key */
  private getClient(): GoogleGenAI {
    if (!env.geminiApiKey) throw new AiProviderError('not_configured');
    // The key is passed explicitly (never picked up from GOOGLE_API_KEY & co. by accident),
    // and vertexai: false pins the Gemini Developer API whatever the environment says
    this.client ??= new GoogleGenAI({
      apiKey: env.geminiApiKey,
      vertexai: false,
      httpOptions: {
        timeout: 60_000, // per attempt
        // Retries 408/5xx ("high demand" is a 503) before the stream starts. Not 429:
        // an exhausted quota stays exhausted, and every retry spends it again
        retryOptions: {
          attempts: 3,
          httpStatusCodes: [408, 500, 502, 503, 504],
        },
      },
    });
    return this.client;
  }

  /**
   * SDK errors → AiFailure. Logged by class, HTTP status and a fixed reason only — never
   * the SDK's message itself (it can hold reply text): no key, no prompt, no user text.
   */
  private toProviderError(
    error: unknown,
    signal?: AbortSignal,
  ): AiProviderError {
    if (error instanceof AiProviderError) return error;
    // The browser went away (our signal) — or the SDK's own per-attempt timeout fired
    if (signal?.aborted) return new AiProviderError('aborted');

    const failure = ((): AiProviderError['failure'] => {
      if (isAbort(error)) return 'timeout';
      if (error instanceof ApiError) {
        // Google answers 400 API_KEY_INVALID for a wrong key
        if (error.status === 400 && error.message.includes('API_KEY_INVALID'))
          return 'not_configured';
        if (error.status === 401 || error.status === 403)
          return 'not_configured';
        if (error.status === 429) return 'busy';
        if (error.status === 408 || error.status === 504) return 'timeout';
        if (error.status >= 400 && error.status < 500) return 'invalid_request';
      }
      return 'unavailable'; // 5xx, network trouble, anything unexpected
    })();

    const status = error instanceof ApiError ? String(error.status) : '-';
    this.logger.warn(
      `Gemini request failed: ${error instanceof Error ? error.constructor.name : 'unknown'} (status ${status}, ${reasonOf(error)}) → ${failure}`,
    );
    return new AiProviderError(failure);
  }
}

/**
 * Why a call failed, as a fixed label safe for logs:
 * - an ApiError: Google's status code word (UNAVAILABLE, RESOURCE_EXHAUSTED, …)
 * - the SDK's "Incomplete JSON segment": the stream was cut off mid-reply — Google ended
 *   a streamed answer with an error the SDK can't read (seen under "high demand" / quota)
 */
function reasonOf(error: unknown): string {
  if (error instanceof ApiError) {
    return /"status":\s*"([A-Z_]+)"/.exec(error.message)?.[1] ?? 'api error';
  }
  if (isAbort(error)) return 'aborted or timed out';
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('Incomplete JSON segment')) return 'stream cut off';
  if (message.startsWith('exception parsing stream chunk'))
    return 'unreadable stream chunk';
  if (error instanceof TypeError) return 'network';
  return 'unexpected';
}

/** Our turns in Gemini's shape: the assistant is "model" */
const toContent = ({ role, content }: AiTurn): Content => ({
  role: role === 'assistant' ? 'model' : 'user',
  parts: [{ text: content }],
});

/** The visible text of one streamed chunk (thoughts skipped); throws on a safety stop */
function* textOf(chunk: GenerateContentResponse): Generator<string> {
  if (chunk.promptFeedback?.blockReason) throw new AiProviderError('refused');
  const candidate = chunk.candidates?.[0];
  for (const part of candidate?.content?.parts ?? []) {
    if (part.text && !part.thought) yield part.text;
  }
  if (candidate?.finishReason && REFUSALS.has(candidate.finishReason)) {
    throw new AiProviderError('refused');
  }
}

/**
 * fetch rejects with AbortError (or TimeoutError) when a signal fires. By name, not
 * instanceof: a DOMException from another realm can reach the SDK, which then wraps it
 * in a plain Error with the original as `cause`.
 */
function isAbort(error: unknown): boolean {
  const { name, cause } = (error ?? {}) as { name?: unknown; cause?: unknown };
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  return cause !== undefined && cause !== error && isAbort(cause);
}
