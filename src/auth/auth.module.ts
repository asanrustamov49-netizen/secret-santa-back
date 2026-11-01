import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { env } from '../config/env';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthRateLimitGuard, AuthRateLimitService } from './auth-rate-limit';
import { AuthService } from './auth.service';
import { GoogleStrategy } from './google.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ReauthService } from './reauth.service';
import { SessionsService } from './sessions.service';

@Module({
  imports: [UsersModule, JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionsService,
    ReauthService,
    AuthRateLimitService,
    AuthRateLimitGuard,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    ...(env.google ? [GoogleStrategy] : []),
  ],
  exports: [SessionsService, ReauthService],
})
export class AuthModule {}
