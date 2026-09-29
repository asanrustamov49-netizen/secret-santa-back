import { IsBoolean, IsIn, ValidateIf } from 'class-validator';
import { RawValue } from '../../common/validation/raw-value';
import type { ThemePreference } from '../../users/users.service';

export const THEME_PREFERENCES: ThemePreference[] = ['light', 'dark', 'system'];

/** Present fields are validated; `null` is rejected rather than read as "no change" */
const sent = (_: object, value: unknown) => value !== undefined;

/**
 * PATCH /account/preferences — send only what changes, at least one field.
 * Unknown fields are rejected by the global pipe (forbidNonWhitelisted).
 */
export class UpdatePreferencesDto {
  @ValidateIf(sent)
  @RawValue()
  @IsIn(THEME_PREFERENCES, {
    message: `themePreference must be one of: ${THEME_PREFERENCES.join(', ')}`,
  })
  themePreference?: ThemePreference;

  @ValidateIf(sent)
  @RawValue()
  @IsBoolean({ message: 'notifyEmail must be true or false' })
  notifyEmail?: boolean;

  @ValidateIf(sent)
  @RawValue()
  @IsBoolean({ message: 'notifyReminders must be true or false' })
  notifyReminders?: boolean;

  @ValidateIf(sent)
  @RawValue()
  @IsBoolean({ message: 'notifyInvites must be true or false' })
  notifyInvites?: boolean;
}
