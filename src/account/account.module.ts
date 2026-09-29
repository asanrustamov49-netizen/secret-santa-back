import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { AccountController } from './account.controller';
import { PasswordService } from './password.service';

// Account settings — /api/account/*: preferences and the password.
// AuthModule provides session revocation and the Google re-authentication grant.
@Module({
  imports: [UsersModule, AuthModule],
  controllers: [AccountController],
  providers: [PasswordService],
})
export class AccountModule {}
