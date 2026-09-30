import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { WishlistService } from './wishlist.service';

// Profile (name, interests) and the wishlist — /api/profile/*
@Module({
  imports: [RealtimeModule],
  controllers: [UsersController],
  providers: [UsersService, WishlistService],
  exports: [UsersService, WishlistService],
})
export class UsersModule {}
