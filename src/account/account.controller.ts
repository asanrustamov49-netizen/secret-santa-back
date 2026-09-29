import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  NotFoundException,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ReauthService } from '../auth/reauth.service';
import { CurrentUser } from '../common/auth/current-user.decorator';
import type { AuthUser } from '../common/auth/auth.types';
import { RateLimit } from '../common/throttle/rate-limit';
import { toPublicUser, UsersService } from '../users/users.service';
import { ChangePasswordDto, SetPasswordDto } from './dto/password.dto';
import { UpdatePreferencesDto } from './dto/preferences.dto';
import { PasswordService } from './password.service';

/**
 * The signed-in user's own account settings — /api/account/*.
 * Kept apart from /profile, which is what other participants get to see.
 * Every route needs sign-in (global JwtAuthGuard); the user always comes from
 * the access token, never from the request body or URL.
 */
@Controller('account')
export class AccountController {
  constructor(
    private readonly users: UsersService,
    private readonly password: PasswordService,
    private readonly reauth: ReauthService,
  ) {}

  @Patch('preferences')
  @RateLimit('preferences')
  async updatePreferences(
    @CurrentUser() me: AuthUser,
    @Body() dto: UpdatePreferencesDto,
  ) {
    const changes = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    ) as Partial<UpdatePreferencesDto>;
    if (Object.keys(changes).length === 0) {
      throw new BadRequestException('Nothing to update');
    }

    const user = await this.users.updatePreferences(me.id, changes);
    if (!user) throw new NotFoundException('Account not found');
    return { user: toPublicUser(user) };
  }

  /** Change the password: the current one proves it's you. Other devices are signed out. */
  @Post('password')
  @HttpCode(204)
  @RateLimit('sensitive')
  async changePassword(
    @CurrentUser() me: AuthUser,
    @Body() dto: ChangePasswordDto,
  ) {
    await this.password.change(me, dto.currentPassword, dto.newPassword);
  }

  /**
   * First password for a Google-only account. With no current password to check,
   * a fresh Google confirmation (the reauth grant cookie) proves it's you.
   */
  @Post('password/set')
  @HttpCode(200)
  @RateLimit('sensitive')
  async setPassword(
    @CurrentUser() me: AuthUser,
    @Body() dto: SetPasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.password.assertHasNoPassword(me.id);
    if (!(await this.reauth.isGrantedFor(req, me.id))) {
      throw PasswordService.reauthRequired();
    }

    const user = await this.password.setFirst(me, dto.newPassword);
    this.reauth.clear(res);
    return { user };
  }
}
