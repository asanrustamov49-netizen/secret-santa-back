import type { CookieOptions, Response } from 'express';
import { env } from '../config/env';

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
export const SESSION_HINT_COOKIE = 'has_session';

const base: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: env.isProduction,
};

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
