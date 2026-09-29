import { IsString, MaxLength, MinLength } from 'class-validator';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_TOO_LONG,
  PASSWORD_TOO_SHORT,
} from '../../auth/dto/auth.dto';
import { RawValue } from '../../common/validation/raw-value';

// Same rules for new passwords as at sign-up. @RawValue: a number must not sneak
// through as a password via the pipe's implicit type conversion.

/** POST /account/password */
export class ChangePasswordDto {
  @RawValue()
  @IsString()
  @MinLength(1, { message: 'Enter your current password' })
  @MaxLength(PASSWORD_MAX_LENGTH, { message: PASSWORD_TOO_LONG })
  currentPassword: string;

  @RawValue()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_TOO_SHORT })
  @MaxLength(PASSWORD_MAX_LENGTH, { message: PASSWORD_TOO_LONG })
  newPassword: string;
}

/** POST /account/password/set — a first password for a Google-only account */
export class SetPasswordDto {
  @RawValue()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_TOO_SHORT })
  @MaxLength(PASSWORD_MAX_LENGTH, { message: PASSWORD_TOO_LONG })
  newPassword: string;
}
