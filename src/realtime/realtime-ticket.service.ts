import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import { env } from '../config/env';
import type { AuthUser } from '../common/auth/auth.types';
import { DatabaseService } from '../database/database.service';

/**
 * A short-lived pass for opening the realtime socket.
 *
 * Why not the access-token cookie itself: the browser talks to the API through the
 * Next.js /api rewrite (first-party cookies), but WebSockets can't go through that
 * proxy — the socket connects to the API host directly, where those cookies are never
 * sent. So the page asks for a ticket over the usual cookie-authenticated REST call
 * (same JwtAuthGuard, same session) and hands it over in the Socket.IO handshake
 * payload — never in a URL, never logged.
 *
 * Like the reauth grant, it is signed with a key derived from the access-token
 * secret, so it can never pass as an access token (nor the other way round).
 */
export const TICKET_TTL_SECONDS = 60;
const PURPOSE = 'realtime';

const ticketSecret = createHash('sha256')
  .update(`${env.jwtAccessSecret}:realtime-ticket`)
  .digest('base64url');

@Injectable()
export class RealtimeTicketService {
  constructor(
    private readonly jwt: JwtService,
    private readonly db: DatabaseService,
  ) {}

  issue(user: AuthUser): Promise<string> {
    return this.jwt.signAsync(
      { sub: user.id, sid: user.sessionId, purpose: PURPOSE },
      { secret: ticketSecret, expiresIn: TICKET_TTL_SECONDS },
    );
  }

  /** The user id a valid ticket belongs to — null for anything else */
  async verify(ticket: unknown): Promise<string | null> {
    if (typeof ticket !== 'string' || !ticket || ticket.length > 2048) {
      return null;
    }
    let payload: { sub?: string; sid?: string; purpose?: string };
    try {
      payload = await this.jwt.verifyAsync(ticket, { secret: ticketSecret });
    } catch {
      return null; // expired, tampered, or signed with another key
    }
    if (payload.purpose !== PURPOSE || !payload.sub) return null;

    // The session it was issued for must still be alive: "log out everywhere"
    // and password changes end it, and then no new socket opens on it
    const [row] = await this.db.query<{ ok: boolean }>(
      payload.sid
        ? `select true as ok from refresh_tokens
           where id = $1 and user_id = $2 and revoked_at is null and expires_at > now()`
        : `select true as ok from users where id = $2`,
      [payload.sid ?? null, payload.sub],
    );
    return row?.ok ? payload.sub : null;
  }
}
