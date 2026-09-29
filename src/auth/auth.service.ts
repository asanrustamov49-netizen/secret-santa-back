import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { isEmail } from 'class-validator';
import { randomBytes } from 'node:crypto';
import { DatabaseError } from 'pg';
import type { AuthUser } from '../common/auth/auth.types';
import { env } from '../config/env';
import { DatabaseService } from '../database/database.service';
import {
  toPublicUser,
  UsersService,
  type PublicUser,
} from '../users/users.service';
import { hashPassword, verifyPassword } from './password';
import { hashRefreshToken, SessionsService } from './sessions.service';
import type { LoginDto, RegisterDto } from './dto/auth.dto';
import type { GoogleProfile } from './google.strategy';

export interface Session {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

// Verified against when the email doesn't exist, so "no such user" and
// "wrong password" take the same time and can't be told apart.
const DUMMY_HASH_PROMISE = hashPassword('dummy-password-for-timing');

// Two tabs refreshing at the same moment is normal, not theft
const REUSE_GRACE_MS = 30_000;

/**
 * Lost a refresh race to another tab of the same browser: that tab already got
 * fresh cookies, so this response must not clear them (see AuthController.refresh).
 */
export class RefreshRaceError extends UnauthorizedException {
  constructor() {
    super('Session expired');
  }
}

// Password guessing: after this many failures for one email within the window,
// further attempts are refused until the window passes. In memory — per instance.
const MAX_LOGIN_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;
const loginFailures = new Map<string, number[]>();

function recentFailures(email: string, now: number) {
  // Many different emails sprayed at us: drop stale entries so the map stays small
  if (loginFailures.size > 10_000) {
    for (const [key, times] of loginFailures) {
      if (times.every((t) => now - t >= LOGIN_WINDOW_MS))
        loginFailures.delete(key);
    }
  }
  const recent = (loginFailures.get(email) ?? []).filter(
    (t) => now - t < LOGIN_WINDOW_MS,
  );
  if (recent.length) loginFailures.set(email, recent);
  else loginFailures.delete(email);
  return recent;
}

const UNIQUE_VIOLATION = '23505';

/** Becomes /login?error=<code> on the frontend */
export class GoogleSignInError extends Error {
  constructor(
    readonly code:
      | 'google'
      | 'google_email_not_verified'
      | 'google_account_exists'
      // ?intent=reauth only — see reauthenticateWithGoogle
      | 'reauth_no_session'
      | 'reauth_wrong_account',
    message: string,
  ) {
    super(message);
  }
}

function normalizeGoogleEmail(email: string | undefined): string | null {
  const value = email?.trim().toLowerCase();
  return value && value.length <= 254 && isEmail(value) ? value : null;
}

// users.name must be 2–60 characters (char_length counts code points, as Array.from does)
const NAME_MIN = 2;
const NAME_MAX = 60;

function cleanName(value: string): string {
  const collapsed = value
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(collapsed).slice(0, NAME_MAX).join('').trim();
}

/** Google's name, else the email's local part made readable ("anna.smith" → "anna smith") */
function googleDisplayName(name: string | undefined, email: string): string {
  const fromProfile = cleanName(name ?? '');
  if (Array.from(fromProfile).length >= NAME_MIN) return fromProfile;

  const fromEmail = cleanName(email.split('@')[0].replace(/[._+-]+/g, ' '));
  if (Array.from(fromEmail).length >= NAME_MIN) return fromEmail;

  return 'Secret Santa';
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly sessions: SessionsService,
  ) {}

  async register(dto: RegisterDto, userAgent?: string): Promise<Session> {
    if (await this.users.findByEmail(dto.email)) {
      throw new ConflictException('An account with this email already exists');
    }

    try {
      const user = await this.users.create({
        name: dto.name,
        email: dto.email,
        passwordHash: await hashPassword(dto.password),
      });
      return this.createSession(toPublicUser(user), userAgent);
    } catch (error) {
      // Same email registered in parallel — the unique index is the final word
      if (error instanceof DatabaseError && error.code === UNIQUE_VIOLATION) {
        throw new ConflictException(
          'An account with this email already exists',
        );
      }
      throw error;
    }
  }

  async login(dto: LoginDto, userAgent?: string): Promise<Session> {
    const now = Date.now();
    // Checked before the password, so a locked-out guesser learns nothing either way
    if (recentFailures(dto.email, now).length >= MAX_LOGIN_FAILURES) {
      throw new HttpException(
        'Too many sign-in attempts. Try again in a few minutes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.users.findByEmail(dto.email);
    const passwordOk = await verifyPassword(
      dto.password,
      user?.passwordHash ?? (await DUMMY_HASH_PROMISE),
    );

    if (!user || !user.passwordHash || !passwordOk) {
      loginFailures.set(dto.email, [...recentFailures(dto.email, now), now]);
      throw new UnauthorizedException('Invalid email or password');
    }

    loginFailures.delete(dto.email);
    return this.createSession(toPublicUser(user), userAgent);
  }

  /** Swap a valid refresh token for a new pair (rotation). */
  async refresh(
    refreshToken: string | undefined,
    userAgent?: string,
  ): Promise<Session> {
    if (!refreshToken) throw new UnauthorizedException('Not signed in');

    const stored = await this.db.one<{
      id: string;
      userId: string;
      expiresAt: Date;
      revokedAt: Date | null;
    }>(
      `select id, user_id as "userId", expires_at as "expiresAt", revoked_at as "revokedAt"
       from refresh_tokens where token_hash = $1`,
      [hashRefreshToken(refreshToken)],
    );

    if (!stored || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Session expired');
    }

    if (stored.revokedAt) {
      // An old token used again long after rotation means it leaked: end every session.
      if (Date.now() - stored.revokedAt.getTime() > REUSE_GRACE_MS) {
        await this.sessions.revokeAllForUser(stored.userId);
        throw new UnauthorizedException('Session expired');
      }
      // Rotated moments ago by another tab — not theft, and that tab holds the new pair
      throw new RefreshRaceError();
    }

    // Conditional update: if a parallel request rotated it first, we lose the race cleanly
    const rotated = await this.db.query(
      `update refresh_tokens set revoked_at = now()
       where id = $1 and revoked_at is null
       returning id`,
      [stored.id],
    );
    if (rotated.length === 0) throw new RefreshRaceError();

    const user = await this.users.findById(stored.userId);
    if (!user) throw new UnauthorizedException('Session expired');

    return this.createSession(toPublicUser(user), userAgent);
  }

  async logout(refreshToken: string | undefined) {
    if (!refreshToken) return;
    await this.sessions.revokeToken(refreshToken);
  }

  /**
   * "Log out of all devices": every other session of the user ends; the one making
   * the request (sessionId from its access token) stays signed in.
   */
  logoutAll(user: AuthUser): Promise<number> {
    return this.sessions.revokeAllForUser(user.id, {
      exceptSessionId: user.sessionId,
    });
  }

  /**
   * ?intent=reauth: the signed-in user has just come back from Google. Nobody is
   * signed in or created here — it only confirms that the Google account Google
   * vouched for is the one already connected to the account of this session.
   * The session comes from the refresh cookie (it reaches /api/auth/*; the access
   * token may well have expired during the trip). Returns the user id.
   */
  async reauthenticateWithGoogle(
    profile: GoogleProfile,
    refreshToken: string | undefined,
  ): Promise<string> {
    const session = await this.sessions.findActive(refreshToken);
    if (!session) {
      throw new GoogleSignInError(
        'reauth_no_session',
        'No active session to confirm',
      );
    }

    const user = await this.users.findById(session.userId);
    if (!user?.googleId || user.googleId !== profile.googleId) {
      throw new GoogleSignInError(
        'reauth_wrong_account',
        'Google account is not the one connected to this account',
      );
    }
    return user.id;
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException('Not signed in');
    return toPublicUser(user);
  }

  /**
   * Google proved who the user is; from here it is an ordinary session.
   * Order: known google_id → signs in; an email nobody uses yet → a new
   * password-less account. An email that already has an account is refused
   * (see createGoogleUserUnlessTaken) — never linked automatically.
   */
  async loginWithGoogle(
    profile: GoogleProfile,
    userAgent?: string,
  ): Promise<Session> {
    const email = normalizeGoogleEmail(profile.email);
    if (!profile.googleId || !email) {
      throw new GoogleSignInError(
        'google',
        'Google profile has no valid email',
      );
    }
    // An unverified address could belong to someone else — never create or link on it
    if (!profile.emailVerified) {
      throw new GoogleSignInError(
        'google_email_not_verified',
        'Google email is not verified',
      );
    }

    const avatarUrl = profile.picture?.startsWith('https://')
      ? profile.picture
      : null;

    const user =
      (await this.users.findByGoogleId(profile.googleId)) ??
      (await this.createGoogleUserUnlessTaken(
        profile.googleId,
        email,
        profile.name,
        avatarUrl,
      ));

    return this.createSession(toPublicUser(user), userAgent);
  }

  /**
   * Email/password sign-up never proves the address belongs to whoever registered it.
   * Linking a Google sign-in to such an account by matching email would hand the
   * mailbox owner an account someone else may have pre-registered — and still holds
   * the password to. So an email that already has an account is refused here; the
   * owner signs in with their password (linking Google will be an explicit step for
   * an already signed-in user).
   */
  private async createGoogleUserUnlessTaken(
    googleId: string,
    email: string,
    name: string | undefined,
    avatarUrl: string | null,
  ) {
    if (await this.users.findByEmail(email)) {
      throw new GoogleSignInError(
        'google_account_exists',
        'An account with this email already exists',
      );
    }

    try {
      return await this.users.createGoogleUser({
        email,
        name: googleDisplayName(name, email),
        googleId,
        avatarUrl,
      });
    } catch (error) {
      // Same account created by a parallel callback — the unique indexes decide
      if (error instanceof DatabaseError && error.code === UNIQUE_VIOLATION) {
        throw new GoogleSignInError('google', 'Account created concurrently');
      }
      throw error;
    }
  }

  private async createSession(
    user: PublicUser,
    userAgent?: string,
  ): Promise<Session> {
    const refreshToken = randomBytes(48).toString('base64url');
    const [session] = await this.db.query<{ id: string }>(
      `insert into refresh_tokens (user_id, token_hash, expires_at, user_agent)
       values ($1, $2, now() + make_interval(days => $3), $4)
       returning id`,
      [
        user.id,
        hashRefreshToken(refreshToken),
        env.refreshTokenTtlDays,
        userAgent?.slice(0, 255) ?? null,
      ],
    );

    // sid = this session's refresh_tokens row. It lets routes outside /api/auth
    // (where the refresh cookie never travels) tell "this device" from the others,
    // e.g. to keep it signed in when every other session is revoked.
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, sid: session.id },
      { secret: env.jwtAccessSecret, expiresIn: env.accessTokenTtlSeconds },
    );

    return { user, accessToken, refreshToken };
  }
}
