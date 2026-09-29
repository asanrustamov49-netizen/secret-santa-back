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
import { UpdateProfileDto, WishlistItemDto } from './dto/profile.dto';
import { toPublicUser, UsersService } from './users.service';
import { WishlistService } from './wishlist.service';

/** The signed-in user's own profile and wishlist (global JwtAuthGuard protects every route) */
@Controller('profile')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly wishlist: WishlistService,
  ) {}

  @Patch()
  async update(@CurrentUser() me: AuthUser, @Body() dto: UpdateProfileDto) {
    const user = await this.users.updateProfile(me.id, dto);
    if (!user) throw new NotFoundException('Account not found');
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
    return { item: await this.wishlist.add(me.id, dto) };
  }

  @Put('wishlist/:id')
  async updateWishlistItem(
    @CurrentUser() me: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WishlistItemDto,
  ) {
    return { item: await this.wishlist.update(me.id, id, dto) };
  }

  @Delete('wishlist/:id')
  @HttpCode(204)
  async removeWishlistItem(
    @CurrentUser() me: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.wishlist.remove(me.id, id);
  }
}
