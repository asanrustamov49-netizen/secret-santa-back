import { Injectable } from '@nestjs/common';
import { DatabaseService, type Queryable } from '../database/database.service';

export type ThemePreference = 'light' | 'dark' | 'system';

/** A users row with camelCase keys (see USER_COLUMNS) */
export interface UserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string | null;
  googleId: string | null;
  avatarUrl: string | null;
  interests: string[];
  themePreference: ThemePreference;
  notifyEmail: boolean;
  notifyReminders: boolean;
  notifyInvites: boolean;
  createdAt: Date;
}

/** Account settings the user changes themselves (PATCH /account/preferences) */
export type UserPreferences = Pick<
  UserRecord,
  'themePreference' | 'notifyEmail' | 'notifyReminders' | 'notifyInvites'
>;

/**
 * The shape of a user that may leave the API. Listed field by field on purpose
 * (not Omit<UserRecord, …>): a column added to UserRecord later stays private
 * until someone decides to publish it. The password hash and Google id never
 * leave — only whether they exist.
 */
export interface PublicUser extends UserPreferences {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  interests: string[];
  /** Can sign in with a password (false for Google-only accounts) */
  hasPassword: boolean;
  /** A Google account is connected */
  hasGoogle: boolean;
  createdAt: Date;
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    interests: user.interests,
    hasPassword: user.passwordHash !== null,
    hasGoogle: user.googleId !== null,
    themePreference: user.themePreference,
    notifyEmail: user.notifyEmail,
    notifyReminders: user.notifyReminders,
    notifyInvites: user.notifyInvites,
    createdAt: user.createdAt,
  };
}

// snake_case columns → camelCase keys, in one place
export const USER_COLUMNS = `
  id,
  email,
  name,
  password_hash    as "passwordHash",
  google_id        as "googleId",
  avatar_url       as "avatarUrl",
  interests,
  theme_preference as "themePreference",
  notify_email     as "notifyEmail",
  notify_reminders as "notifyReminders",
  notify_invites   as "notifyInvites",
  created_at       as "createdAt"
`;

@Injectable()
export class UsersService {
  constructor(private readonly db: DatabaseService) {}

  findById(id: string) {
    return this.db.one<UserRecord>(
      `select ${USER_COLUMNS} from users where id = $1`,
      [id],
    );
  }

  findByEmail(email: string) {
    return this.db.one<UserRecord>(
      `select ${USER_COLUMNS} from users where email = $1`,
      [email],
    );
  }

  async create(data: { email: string; name: string; passwordHash: string }) {
    const user = await this.db.one<UserRecord>(
      `insert into users (email, name, password_hash)
       values ($1, $2, $3)
       returning ${USER_COLUMNS}`,
      [data.email, data.name, data.passwordHash],
    );
    return user!;
  }

  /** Only the fields that were sent change (coalesce keeps the rest) */
  async updateProfile(
    userId: string,
    data: { name?: string; interests?: string[] },
  ) {
    return this.db.one<UserRecord>(
      `update users
       set name = coalesce($2, name), interests = coalesce($3, interests)
       where id = $1
       returning ${USER_COLUMNS}`,
      [userId, data.name ?? null, data.interests ?? null],
    );
  }

  /**
   * Only the fields that were sent change. Keyed by the signed-in user's id from
   * the access token — there is no way to address someone else's row.
   */
  updatePreferences(userId: string, data: Partial<UserPreferences>) {
    return this.db.one<UserRecord>(
      `update users
       set theme_preference = coalesce($2::theme_preference, theme_preference),
           notify_email     = coalesce($3, notify_email),
           notify_reminders = coalesce($4, notify_reminders),
           notify_invites   = coalesce($5, notify_invites)
       where id = $1
       returning ${USER_COLUMNS}`,
      [
        userId,
        data.themePreference ?? null,
        data.notifyEmail ?? null,
        data.notifyReminders ?? null,
        data.notifyInvites ?? null,
      ],
    );
  }

  /** Stores a new password hash; accepts a transaction so sessions can be ended with it */
  async setPasswordHash(
    userId: string,
    passwordHash: string,
    tx: Queryable = this.db,
  ) {
    const [user] = await tx.query<UserRecord>(
      `update users set password_hash = $2
       where id = $1
       returning ${USER_COLUMNS}`,
      [userId, passwordHash],
    );
    return user ?? null;
  }

  findByGoogleId(googleId: string) {
    return this.db.one<UserRecord>(
      `select ${USER_COLUMNS} from users where google_id = $1`,
      [googleId],
    );
  }

  /** Google-only account: no password (users_has_login accepts google_id instead) */
  async createGoogleUser(data: {
    email: string;
    name: string;
    googleId: string;
    avatarUrl: string | null;
  }) {
    const user = await this.db.one<UserRecord>(
      `insert into users (email, name, google_id, avatar_url)
       values ($1, $2, $3, $4)
       returning ${USER_COLUMNS}`,
      [data.email, data.name, data.googleId, data.avatarUrl],
    );
    return user!;
  }

  /**
   * Attaches a Google account to an existing user and fills an empty avatar.
   * Null when the user is gone or already linked to a different Google account.
   * Only for an explicit "connect Google" by an already signed-in user — never
   * from the sign-in flow by matching email (see AuthService.loginWithGoogle).
   */
  linkGoogleAccount(
    userId: string,
    googleId: string,
    avatarUrl?: string | null,
  ) {
    return this.db.one<UserRecord>(
      `update users
       set google_id = $2, avatar_url = coalesce(avatar_url, $3)
       where id = $1 and (google_id is null or google_id = $2)
       returning ${USER_COLUMNS}`,
      [userId, googleId, avatarUrl ?? null],
    );
  }
}
