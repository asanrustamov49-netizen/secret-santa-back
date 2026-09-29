import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  PipeTransform,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { Public } from '../common/auth/public.decorator';
import type { AuthUser } from '../common/auth/auth.types';
import { EventsService } from './events.service';

/** Invite codes are base64url; anything else can't be one */
class InviteCodePipe implements PipeTransform<string> {
  transform(value: string) {
    if (!/^[A-Za-z0-9_-]{6,32}$/.test(value)) {
      throw new BadRequestException('This invite link is not valid');
    }
    return value;
  }
}

/** /join/<code> on the frontend talks to these */
@Controller('invites')
export class InvitesController {
  constructor(private readonly events: EventsService) {}

  // Guests see the preview before signing up
  @Public()
  @Get(':code')
  async preview(@Param('code', InviteCodePipe) code: string) {
    return { invite: await this.events.invitePreview(code) };
  }

  @Post(':code/join')
  @HttpCode(200)
  join(
    @CurrentUser() me: AuthUser,
    @Param('code', InviteCodePipe) code: string,
  ) {
    return this.events.join(me.id, code);
  }
}

/** /my-santa: every recipient I drew, across events */
@Controller('matches')
export class MatchesController {
  constructor(private readonly events: EventsService) {}

  @Get()
  async list(@CurrentUser() me: AuthUser) {
    return { matches: await this.events.myMatches(me.id) };
  }
}
