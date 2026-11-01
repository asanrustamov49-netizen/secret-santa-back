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
    if (newPassword === currentPassword) {
      throw new BadRequestException(
        'New password must be different from the current one',
      );
    }
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new ForbiddenException('Current password is incorrect');
    }

    await this.replacePassword(me, newPassword);
  }

  async setFirst(me: AuthUser, newPassword: string) {
    await this.assertHasNoPassword(me.id);
    return toPublicUser(await this.replacePassword(me, newPassword));
  }

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
