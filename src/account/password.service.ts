import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '../common/auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { hashPassword, verifyPassword } from '../auth/password';
import { SessionsService } from '../auth/sessions.service';
import { toPublicUser, UsersService } from '../users/users.service';

/**
 * Changing or setting the account password. Either way the new hash and the
 * end of every *other* session commit together: whoever might have known the
 * old credentials loses their sessions, while this device stays signed in.
 * (Other devices' access tokens still run out on their own — at most 15 min.)
 */
@Injectable()
export class PasswordService {
  constructor(
    private readonly db: DatabaseService,
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
  ) {}

  async change(
    me: AuthUser,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.users.findById(me.id);
    if (!user) throw new NotFoundException('Account not found');
    if (!user.passwordHash) {
      throw new ConflictException(
        "This account doesn't have a password yet — set one instead",
      );
    }
    // Compares two inputs, reveals nothing about the stored one
    if (newPassword === currentPassword) {
      throw new BadRequestException(
        'New password must be different from the current one',
      );
    }
    // 403, not 401: a wrong password here is not an expired session, and a 401
    // would make the browser client refresh and replay the guess
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new ForbiddenException('Current password is incorrect');
    }

    await this.replacePassword(me, newPassword);
  }

  /** First password of a Google-only account; the caller has checked the reauth grant */
  async setFirst(me: AuthUser, newPassword: string) {
    await this.assertHasNoPassword(me.id);
    return toPublicUser(await this.replacePassword(me, newPassword));
  }

  /** Throws unless the account has no password yet */
  async assertHasNoPassword(userId: string) {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException('Account not found');
    if (user.passwordHash) {
      throw new ConflictException(
        'This account already has a password — change it instead',
      );
    }
  }

  static reauthRequired() {
    return new ForbiddenException(
      "Confirm it's you with Google first, then set your password within 5 minutes",
    );
  }

  private async replacePassword(me: AuthUser, newPassword: string) {
    const hash = await hashPassword(newPassword); // slow — outside the transaction
    return this.db.transaction(async (tx) => {
      const updated = await this.users.setPasswordHash(me.id, hash, tx);
      if (!updated) throw new NotFoundException('Account not found');
      await this.sessions.revokeAllForUser(me.id, {
        exceptSessionId: me.sessionId,
        tx,
      });
      return updated;
    });
  }
}
