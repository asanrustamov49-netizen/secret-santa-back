import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { CookieOptions, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { env } from '../config/env';

/**
 * Proof that the signed-in user has *just* confirmed their identity again with
 * Google (the ?intent=reauth round trip). It unlocks setting a first password on
 * a Google-only account, which has no current password to check instead.
 *
 * A short-lived JWT in an httpOnly cookie that only /api/account ever receives.
 * It is signed with a key derived from — not equal to — the access-token secret,
 * so it can never pass as an access token (nor the other way round).
 */
export const REAUTH_COOKIE = 'reauth_grant';
const REAUTH_TTL_SECONDS = 5 * 60;
const PURPOSE = 'reauth';

const grantSecret = createHash('sha256')
  .update(`${env.jwtAccessSecret}:reauth-grant`)
  .digest('base64url');

const cookieOptions: CookieOptions = {
  httpOnly: true,
  // Only ever needed by our own pages' XHR — never by a cross-site request
  sameSite: 'strict',
  secure: env.isProduction,
  path: '/api/account',
};

@Injectable()
export class ReauthService {
  constructor(private readonly jwt: JwtService) {}

  async grant(res: Response, userId: string) {
    const token = await this.jwt.signAsync(
      { sub: userId, purpose: PURPOSE },
      { secret: grantSecret, expiresIn: REAUTH_TTL_SECONDS },
    );
    res.cookie(REAUTH_COOKIE, token, {
      ...cookieOptions,
      maxAge: REAUTH_TTL_SECONDS * 1000,
    });
  }

  /** True when this request carries an unexpired grant issued to `userId` */
  async isGrantedFor(req: Request, userId: string): Promise<boolean> {
    const token = (req.cookies as Record<string, string> | undefined)?.[
      REAUTH_COOKIE
    ];
    if (!token) return false;
    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        purpose: string;
      }>(token, { secret: grantSecret });
      return payload.purpose === PURPOSE && payload.sub === userId;
    } catch {
      return false; // expired, tampered or signed with another key
    }
  }

  /** One use only: dropped as soon as it has done its job */
  clear(res: Response) {
    res.clearCookie(REAUTH_COOKIE, cookieOptions);
  }
}
