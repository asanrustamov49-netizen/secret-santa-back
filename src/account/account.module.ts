import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { AccountController } from './account.controller';
import { PasswordService } from './password.service';

@Module({
  imports: [UsersModule, AuthModule],
  controllers: [AccountController],
  providers: [PasswordService],
})
export class AccountModule {}
