import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Every route requires a signed-in user by default (global JwtAuthGuard).
 * Mark the few open ones — register, login, invite preview… — with @Public().
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
