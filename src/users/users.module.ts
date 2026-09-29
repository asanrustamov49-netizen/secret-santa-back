import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { WishlistService } from './wishlist.service';

// Profile (name, interests) and the wishlist — /api/profile/*
@Module({
  controllers: [UsersController],
  providers: [UsersService, WishlistService],
  exports: [UsersService, WishlistService],
})
export class UsersModule {}
