import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { CurrentUser } from '../common/auth/current-user.decorator';
import type { AuthUser } from '../common/auth/auth.types';
import { RealtimeEvent } from '../realtime/realtime.events';
import { RealtimeService } from '../realtime/realtime.service';
import { UpdateProfileDto, WishlistItemDto } from './dto/profile.dto';
import { toPublicUser, UsersService } from './users.service';
import { WishlistService } from './wishlist.service';

/**
 * The signed-in user's own profile and wishlist (global JwtAuthGuard protects every route).
 * A change is announced to every event I'm in: my readiness, and my Santa's view of me,
 * may have changed. The announcement names the event only: not me, not the change.
 */
@Controller('profile')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly wishlist: WishlistService,
    private readonly realtime: RealtimeService,
  ) {}

  private announce(
    userId: string,
    event:
      | typeof RealtimeEvent.participantUpdated
      | typeof RealtimeEvent.wishlistUpdated,
  ) {
    void this.realtime.toUserEvents(userId, event);
  }

  @Patch()
  async update(@CurrentUser() me: AuthUser, @Body() dto: UpdateProfileDto) {
    const user = await this.users.updateProfile(me.id, dto);
    if (!user) throw new NotFoundException('Account not found');
    this.announce(me.id, RealtimeEvent.participantUpdated);
    return { user: toPublicUser(user) };
  }

  @Get('wishlist')
  async listWishlist(@CurrentUser() me: AuthUser) {
    return { items: await this.wishlist.list(me.id) };
  }

  @Post('wishlist')
  async addWishlistItem(
    @CurrentUser() me: AuthUser,
    @Body() dto: WishlistItemDto,
  ) {
    const item = await this.wishlist.add(me.id, dto);
    this.announce(me.id, RealtimeEvent.wishlistUpdated);
    return { item };
  }

  @Put('wishlist/:id')
  async updateWishlistItem(
    @CurrentUser() me: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WishlistItemDto,
  ) {
    const item = await this.wishlist.update(me.id, id, dto);
    this.announce(me.id, RealtimeEvent.wishlistUpdated);
    return { item };
  }

  @Delete('wishlist/:id')
  @HttpCode(204)
  async removeWishlistItem(
    @CurrentUser() me: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.wishlist.remove(me.id, id);
    this.announce(me.id, RealtimeEvent.wishlistUpdated);
  }
}
