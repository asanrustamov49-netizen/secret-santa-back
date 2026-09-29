import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';
import type { StateStore } from 'passport-oauth2';
import { env } from '../config/env';

// OAuth "state" without express-session: a random value goes to Google in the URL
// and into a short-lived httpOnly cookie. The callback must bring the same value
// back, which proves the sign-in was started from this browser (login CSRF).

export const GOOGLE_STATE_COOKIE = 'google_oauth_state';
/** Where to send the user after sign-in (?next= on /api/auth/google) */
export const GOOGLE_NEXT_COOKIE = 'google_oauth_next';
/** Why the round trip was started (?intent= on /api/auth/google) */
export const GOOGLE_INTENT_COOKIE = 'google_oauth_intent';

/**
 * signin — the usual: sign in / sign up with Google.
 * reauth — a signed-in user confirms who they are again (e.g. before setting a
 *          first password). Nobody gets signed in or created by it.
 */
export type GoogleIntent = 'signin' | 'reauth';
const toIntent = (value: unknown): GoogleIntent =>
  value === 'reauth' ? 'reauth' : 'signin';

const DEFAULT_NEXT = '/dashboard';

/**
 * Same-site paths only: "/events/1" yes; "//evil.com", "/\evil.com", "https://…" no.
 * Control characters are refused too: URL parsers drop tabs/newlines, so
 * "/\t/evil.com" would otherwise become "//evil.com" — an off-site redirect.
 */
export function safeNextPath(value: unknown): string {
  return typeof value === 'string' &&
    value.length <= 512 &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : DEFAULT_NEXT;
}

// Only the two Google routes (/api/auth/google and …/callback) ever see it
const stateCookie: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax', // sent on Google's top-level redirect back to us
  secure: env.isProduction,
  path: '/api/auth/google',
};

export function clearGoogleStateCookie(res: Response) {
  res.clearCookie(GOOGLE_STATE_COOKIE, stateCookie);
  res.clearCookie(GOOGLE_NEXT_COOKIE, stateCookie);
  res.clearCookie(GOOGLE_INTENT_COOKIE, stateCookie);
}

/** The ?intent= remembered when the round trip started */
export function googleIntent(req: Request): GoogleIntent {
  return toIntent(
    (req.cookies as Record<string, string> | undefined)?.[GOOGLE_INTENT_COOKIE],
  );
}

/** The ?next= remembered when the sign-in started (validated again on the way out) */
export function googleNextPath(req: Request): string {
  return safeNextPath(
    (req.cookies as Record<string, string> | undefined)?.[GOOGLE_NEXT_COOKIE],
  );
}

function sameState(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

// passport-oauth2 picks the call shape by arity: store(req, cb), verify(req, state, cb)
const store = {
  store(req: Request, callback: (err: Error | null, state?: string) => void) {
    const state = randomBytes(32).toString('base64url');
    const options = {
      ...stateCookie,
      maxAge: env.googleStateTtlSeconds * 1000,
    };
    req.res!.cookie(GOOGLE_STATE_COOKIE, state, options);
    req.res!.cookie(GOOGLE_NEXT_COOKIE, safeNextPath(req.query.next), options);
    req.res!.cookie(GOOGLE_INTENT_COOKIE, toIntent(req.query.intent), options);
    callback(null, state);
  },

  verify(
    req: Request,
    providedState: string | undefined,
    callback: (err: Error | null, ok: boolean, info?: unknown) => void,
  ) {
    const expected = (req.cookies as Record<string, string> | undefined)?.[
      GOOGLE_STATE_COOKIE
    ];
    // One use only, whatever the outcome
    clearGoogleStateCookie(req.res!);

    if (!expected || !providedState || !sameState(expected, providedState)) {
      return callback(null, false, { message: 'Invalid OAuth state' });
    }
    callback(null, true);
  },
};

export const googleStateStore = store as unknown as StateStore;
