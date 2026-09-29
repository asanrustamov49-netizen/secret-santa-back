import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { env } from '../config/env';
import type { GoogleProfile } from './google.strategy';

/**
 * Runs the Google strategy on /auth/google (redirects to Google) and on the
 * callback (state check + code exchange). It never throws: a failed sign-in
 * leaves req.user empty and the controller redirects to /login?error=google,
 * because the callback is a browser navigation, not a JSON call.
 */
@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {
  private readonly logger = new Logger(GoogleAuthGuard.name);

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Not configured → no strategy registered; the handler reports the error
    if (!env.google) return true;
    return (await super.canActivate(context)) as boolean;
  }

  getAuthenticateOptions() {
    // select_account: Google always shows its account picker, so after logging out
    // you can come back as someone else instead of being signed in silently
    return { session: false, prompt: 'select_account' };
  }

  handleRequest<TUser = GoogleProfile>(
    err: unknown,
    user: TUser | false,
    info: unknown,
  ): TUser | null {
    if (err || !user) {
      // Message only: never the authorization code or any token
      const reason =
        err instanceof Error
          ? `${err.name}: ${err.message}`
          : ((info as { message?: string } | undefined)?.message ?? 'denied');
      this.logger.warn(`Google sign-in failed — ${reason}`);
      return null;
    }
    return user;
  }
}
