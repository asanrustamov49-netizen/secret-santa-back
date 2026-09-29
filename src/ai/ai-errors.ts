import { HttpException } from '@nestjs/common';
import { type AiFailure, AiProviderError } from './ai-provider';

/** What the browser learns about a failed AI call: a code the UI words itself, never provider details */
export type AiErrorCode =
  'ai_unavailable' | 'ai_busy' | 'ai_timeout' | 'ai_refused';

const ERRORS: Record<
  Exclude<AiFailure, 'aborted'>,
  [status: number, code: AiErrorCode, message: string]
> = {
  // A missing or rejected key is our configuration problem — the user just sees "unavailable"
  not_configured: [
    503,
    'ai_unavailable',
    'The assistant is unavailable right now',
  ],
  unavailable: [
    503,
    'ai_unavailable',
    'The assistant is unavailable right now',
  ],
  invalid_request: [
    503,
    'ai_unavailable',
    'The assistant is unavailable right now',
  ],
  busy: [503, 'ai_busy', 'The assistant is busy. Try again in a minute'],
  timeout: [504, 'ai_timeout', 'The assistant took too long to answer'],
  refused: [422, 'ai_refused', "The assistant can't help with that request"],
};

export function aiErrorCode(error: unknown): AiErrorCode {
  if (error instanceof AiProviderError && error.failure !== 'aborted')
    return ERRORS[error.failure][1];
  return 'ai_unavailable';
}

/** For errors before the stream starts: provider failures become a JSON error with a code; others pass through */
export function toHttpError(error: unknown): unknown {
  if (!(error instanceof AiProviderError) || error.failure === 'aborted')
    return error;
  const [status, code, message] = ERRORS[error.failure];
  return new HttpException({ statusCode: status, message, code }, status);
}
