import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { RawValue } from '../../common/validation/raw-value';

/** Password rules — one place for sign-up, password change and set-password */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_TOO_SHORT = `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
export const PASSWORD_TOO_LONG = `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;

const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class LoginDto {
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'Enter a valid email' })
  @MaxLength(254)
  email: string;

  // A number or boolean must not pass as a password via implicit conversion
  @RawValue()
  @IsString()
  @MinLength(1, { message: 'Enter your password' })
  @MaxLength(128)
  password: string;
}

export class RegisterDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(2, { message: 'Name must be at least 2 characters' })
  @MaxLength(60)
  name: string;

  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'Enter a valid email' })
  @MaxLength(254)
  email: string;

  @RawValue()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_TOO_SHORT })
  @MaxLength(PASSWORD_MAX_LENGTH, { message: PASSWORD_TOO_LONG })
  password: string;
}
