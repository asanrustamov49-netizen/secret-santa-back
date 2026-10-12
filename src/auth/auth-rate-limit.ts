import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import { DatabaseService } from '../database/database.service';
import { inspectClientIp, ipBucketKey } from './client-ip';

/**
 * Limits for the two public routes that run scrypt: /auth/login and /auth/register.
 *
 * Counted in PostgreSQL (auth_rate_limits, migration 007), so every API instance
 * shares one count. The key is the visitor's IP only when the Next.js proxy signed
 * it (see client-ip.ts); everything else — e.g. calls made straight to the API host —
 * shares one strict "unverified" bucket per route.
 *
 * If the count can't be taken, the sign-in is refused with a plain 503 — with one
 * exception: the table itself is missing (migration 007 not applied). That is a set-up
 * mistake, not an attack, and refusing would lock everybody out of the app; so the request
 * goes on without the limit and an error is logged every minute until 007 is applied.
 * The per-email lockout in AuthService.login and the scrypt queue (password.ts) still apply.
 */
export type AuthAction = 'login' | 'register';

const AUTH_RATE_LIMIT_KEY = 'authRateLimit';

/** Old windows are swept on roughly one call in this many */
const CLEANUP_EVERY = 100;
/** Kept a day past the longest window, then deleted */
const KEEP_SECONDS = 24 * 60 * 60;

/** Same wording as the per-email lockout; the frontend shows its own text for any 429 */
const TOO_MANY = 'Too many sign-in attempts. Try again in a few minutes.';
/** Nothing about the cause reaches the client */
const UNAVAILABLE = 'Service temporarily unavailable';
/** A bad signature, or the missing table, is logged at most this often (every request has it) */
const SIGNATURE_WARNING_EVERY_MS = 60_000;
/** PostgreSQL: relation does not exist */
const UNDEFINED_TABLE = '42P01';

@Injectable()
export class AuthRateLimitService {
  private readonly logger = new Logger(AuthRateLimitService.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Counts one request in the bucket's current fixed window — one atomic upsert, so
   * parallel requests on any number of instances never lose a hit.
   */
  async hit(bucket: string, windowSeconds: number) {
    const [row] = await this.db.query<{ hits: number; resetAt: Date }>(
      `insert into auth_rate_limits (bucket, window_start, hits)
       values ($1, to_timestamp(floor(extract(epoch from now()) / $2::int) * $2::int), 1)
       on conflict (bucket, window_start)
         do update set hits = auth_rate_limits.hits + 1
       returning hits, window_start + make_interval(secs => $2::int) as "resetAt"`,
      [bucket, windowSeconds],
    );
    if (Math.random() * CLEANUP_EVERY < 1) void this.cleanup();
    return row;
  }

  private async cleanup() {
    const longest = Math.max(
      env.authRateLimits.login.windowSeconds,
      env.authRateLimits.register.windowSeconds,
    );
    try {
      await this.db.query(
        `delete from auth_rate_limits where window_start < now() - make_interval(secs => $1::int)`,
        [longest + KEEP_SECONDS],
      );
    } catch (error) {
      this.logger.warn(`Rate limit cleanup failed: ${errorKind(error)}`);
    }
  }
}

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private readonly logger = new Logger('AuthRateLimit');

  constructor(
    private readonly reflector: Reflector,
    private readonly limits: AuthRateLimitService,
  ) {}

  private lastSignatureWarning = 0;
  private lastMissingTableError = 0;

  private reportMissingTable() {
    const now = Date.now();
    if (now - this.lastMissingTableError < SIGNATURE_WARNING_EVERY_MS) return;
    this.lastMissingTableError = now;
    this.logger.error(
      'auth_rate_limits does not exist — apply db/migrations/007_auth_rate_limits.sql. ' +
        'Sign-in limits are OFF until then (sign-in itself keeps working).',
    );
  }

  /**
   * Counted as "unverified" either way; the log is how a wrong setup gets noticed:
   * if it repeats for ordinary sign-ins, CLIENT_IP_SIGNING_SECRET differs between
   * Vercel and here (invalid) or the clocks drift (expired). Only the status is logged.
   */
  private warnSignature(status: 'invalid' | 'expired') {
    const now = Date.now();
    if (now - this.lastSignatureWarning < SIGNATURE_WARNING_EVERY_MS) return;
    this.lastSignatureWarning = now;
    this.logger.warn(
      `Sign-in request with an ${status} client-IP signature, counted as unverified ` +
        `(wrong CLIENT_IP_SIGNING_SECRET on Vercel or here, clock drift, or a forged header)`,
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.get<AuthAction | undefined>(
      AUTH_RATE_LIMIT_KEY,
      context.getHandler(),
    );
    if (!action) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const config = env.authRateLimits[action];
    const secret = env.clientIpSigningSecret;

    const { status, ip } = inspectClientIp(request.headers, secret, Date.now());
    if (status === 'invalid' || status === 'expired')
      this.warnSignature(status);
    const [bucket, limit] =
      ip && secret
        ? [`${action}:ip:${ipBucketKey(ip, secret)}`, config.limit]
        : [`${action}:unverified`, config.unverifiedLimit];

    let result: { hits: number; resetAt: Date };
    try {
      result = await this.limits.hit(bucket, config.windowSeconds);
    } catch (error) {
      if (errorKind(error) === UNDEFINED_TABLE) {
        this.reportMissingTable();
        return true;
      }
      // No bucket or IP in the log — only what kind of failure it was
      this.logger.error(`Rate limit check failed: ${errorKind(error)}`);
      throw new ServiceUnavailableException(UNAVAILABLE);
    }

    if (result.hits > limit) {
      const seconds = Math.ceil(
        (new Date(result.resetAt).getTime() - Date.now()) / 1000,
      );
      http
        .getResponse<Response>()
        .setHeader('Retry-After', String(Math.max(1, seconds)));
      throw new HttpException(TOO_MANY, HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}

/** `@AuthRateLimit('login')` on a route — 429 once its limit is used up, 503 if unknown */
export const AuthRateLimit = (action: AuthAction) =>
  applyDecorators(
    SetMetadata(AUTH_RATE_LIMIT_KEY, action),
    UseGuards(AuthRateLimitGuard),
  );

/** A PostgreSQL error code or the error's class — never its message */
function errorKind(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.constructor.name : 'unknown';
}
