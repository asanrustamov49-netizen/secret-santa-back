export interface AiTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiChatRequest {
  system: string;
  messages: AiTurn[];
  signal?: AbortSignal;
}

export type AiFailure =
  | 'not_configured' // no API key, or the provider rejected it
  | 'unavailable' // provider down or overloaded, network trouble, empty answer
  | 'busy' // the provider's own rate limit
  | 'timeout'
  | 'refused' // the model declined
  | 'invalid_request' // our request was malformed — a bug, not the user's fault
  | 'aborted'; // the browser disconnected

export class AiProviderError extends Error {
  constructor(readonly failure: AiFailure) {
    super(`AI provider: ${failure}`);
  }
}

export interface AiProvider {
  streamChat(request: AiChatRequest): AsyncIterable<string>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');
