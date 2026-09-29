import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService, type Queryable } from '../database/database.service';

/** Refresh tokens are stored only as SHA-256 hashes */
export const hashRefreshToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

/**
 * Ending sessions (refresh tokens). Shared by logout, "log out of all devices",
 * refresh-token reuse detection, password change — and later account deletion.
 *
 * Access tokens are stateless and stay valid until they expire (15 min);
 * revoking stops them from being renewed.
 */
@Injectable()
export class SessionsService {
  constructor(private readonly db: DatabaseService) {}

  /** Ends one session — the one this refresh token belongs to */
  async revokeToken(refreshToken: string, tx: Queryable = this.db) {
    await tx.query(
      `update refresh_tokens set revoked_at = now()
       where token_hash = $1 and revoked_at is null`,
      [hashRefreshToken(refreshToken)],
    );
  }

  /**
   * Ends every active session of the user; returns how many were ended.
   * `exceptSessionId` keeps that session (the current device) signed in — the id
   * travels in the access token as `sid`, so any route can pass it.
   * Accepts a transaction so it can commit together with the change that caused it.
   */
  async revokeAllForUser(
    userId: string,
    {
      exceptSessionId,
      tx = this.db,
    }: { exceptSessionId?: string; tx?: Queryable } = {},
  ): Promise<number> {
    const rows = await tx.query<{ id: string }>(
      `update refresh_tokens set revoked_at = now()
       where user_id = $1 and revoked_at is null
         and ($2::uuid is null or id <> $2::uuid)
       returning id`,
      [userId, exceptSessionId ?? null],
    );
    return rows.length;
  }

  /** The live session behind a refresh token (not revoked, not expired), or null */
  findActive(refreshToken: string | undefined) {
    if (!refreshToken) return Promise.resolve(null);
    return this.db.one<{ id: string; userId: string }>(
      `select id, user_id as "userId" from refresh_tokens
       where token_hash = $1 and revoked_at is null and expires_at > now()`,
      [hashRefreshToken(refreshToken)],
    );
  }
}
