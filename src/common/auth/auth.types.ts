import type { Request } from 'express';

/** What the access token carries and what guarded handlers receive */
export interface AuthUser {
  id: string;
  /**
   * The session (refresh_tokens row) this access token was issued for. Missing only
   * on tokens minted before sessions were tracked — those expire within minutes.
   */
  sessionId?: string;
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
}
