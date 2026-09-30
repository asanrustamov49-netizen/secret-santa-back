import { applyDecorators, Injectable, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth.types';

/**
 * Opt-in rate limits, counted per signed-in user.
 *
 * Why per user and not per IP: the browser reaches this API through the Next.js
 * /api rewrite, which neither adds X-Forwarded-For nor strips a client-sent one.
 * Every request therefore arrives from the Next server's address, and the header
 * can't be trusted — an IP-keyed limit would be one bucket shared by everybody.
 * The user id from the verified access token is the reliable key.
 *
 * Why opt-in: for the same reason a global limit would throttle all users
 * together (e.g. every /auth/refresh). Routes ask for a preset explicitly.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  // Runs after the global JwtAuthGuard, so request.user is already set on guarded
  // routes. Public routes fall back to the connection IP (see the caveat above).
  protected getTracker(req: AuthedRequest): Promise<string> {
    return Promise.resolve(
      req.user ? `user:${req.user.id}` : `ip:${req.ip ?? 'unknown'}`,
    );
  }
}

const MINUTE = 60_000;

/** Limits per route and per user: at most `limit` requests every `ttl` ms */
export const RATE_LIMITS = {
  /** Saving settings: generous, a person clicking toggles never hits it */
  preferences: { limit: 30, ttl: MINUTE },
  /** Session management such as "log out everywhere" */
  sessions: { limit: 5, ttl: MINUTE },
  /** Password change, account deletion — anything worth guessing at */
  sensitive: { limit: 5, ttl: 15 * MINUTE },
  /**
   * A message to the AI assistant. Each one is a paid model call that takes seconds:
   * enough for a lively back-and-forth (one message every 6 s), never a script.
   */
  ai: { limit: 10, ttl: MINUTE },
  /** Starting a new AI conversation — no one needs dozens a minute */
  aiConversations: { limit: 20, ttl: MINUTE },
  /** A message in an event chat: a lively conversation, never a flood */
  chat: { limit: 20, ttl: MINUTE },
  /** A realtime socket ticket: one per (re)connect — room for flaky networks, not for a loop */
  realtime: { limit: 30, ttl: MINUTE },
} as const;

export type RateLimitPreset = keyof typeof RATE_LIMITS;

/** `@RateLimit('sensitive')` on a route — answers 429 once the preset is used up */
export const RateLimit = (preset: RateLimitPreset) =>
  applyDecorators(
    Throttle({ default: RATE_LIMITS[preset] }),
    UseGuards(UserThrottlerGuard),
  );
