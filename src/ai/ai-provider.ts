// The model behind the assistant, behind an interface: AiService never imports a vendor SDK,
// so swapping providers (or stubbing one in tests) touches only the provider class.

/** One turn of history as the model sees it */
export interface AiTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiChatRequest {
  /** Instructions and the Secret Santa context */
  system: string;
  /** The conversation, oldest first; starts with a user turn */
  messages: AiTurn[];
  /** Aborts the call when the browser goes away */
  signal?: AbortSignal;
}

/** What went wrong, in terms the API can turn into a message — never provider internals */
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
  /** The reply as it is written, piece by piece. Throws AiProviderError. */
  streamChat(request: AiChatRequest): AsyncIterable<string>;
}

/** Nest injection token for the active provider */
export const AI_PROVIDER = Symbol('AI_PROVIDER');
