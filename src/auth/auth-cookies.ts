import type { CookieOptions, Response } from 'express';
import { env } from '../config/env';

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
/**
 * Not a credential — just "a session probably exists", readable on every path
 * so the frontend proxy can decide between the app and /login without an API call.
 */
export const SESSION_HINT_COOKIE = 'has_session';

// httpOnly: JavaScript on the page can never read the tokens (XSS can't steal them).
// sameSite=lax: not sent on cross-site POSTs (CSRF protection for our JSON API).
const base: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: env.isProduction,
};

// The refresh token only travels to /api/auth/*, never to regular API calls
const refreshCookie: CookieOptions = { ...base, path: '/api/auth' };
const accessCookie: CookieOptions = { ...base, path: '/' };

export function setAuthCookies(
  res: Response,
  tokens: { accessToken: string; refreshToken: string },
) {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, {
    ...accessCookie,
    maxAge: env.accessTokenTtlSeconds * 1000,
  });
  const refreshMaxAge = env.refreshTokenTtlDays * 24 * 60 * 60 * 1000;
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...refreshCookie,
    maxAge: refreshMaxAge,
  });
  // Readable by page JS on purpose — it holds no secret
  res.cookie(SESSION_HINT_COOKIE, '1', {
    ...accessCookie,
    httpOnly: false,
    maxAge: refreshMaxAge,
  });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, accessCookie);
  res.clearCookie(REFRESH_COOKIE, refreshCookie);
  res.clearCookie(SESSION_HINT_COOKIE, { ...accessCookie, httpOnly: false });
}
