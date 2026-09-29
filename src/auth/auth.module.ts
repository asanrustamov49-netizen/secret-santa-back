import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { env } from '../config/env';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
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
    // Every route in the app requires sign-in unless marked @Public()
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Without credentials there is no strategy; /auth/google then reports ?error=google
    ...(env.google ? [GoogleStrategy] : []),
  ],
  // Reused by account features: ending sessions (password change, deletion)
  // and the Google re-authentication grant (setting a first password)
  exports: [SessionsService, ReauthService],
})
export class AuthModule {}
