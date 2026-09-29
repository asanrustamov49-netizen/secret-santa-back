import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { Public } from '../common/auth/public.decorator';
import type { AuthUser } from '../common/auth/auth.types';
import { RateLimit } from '../common/throttle/rate-limit';
import { env } from '../config/env';
import {
  clearAuthCookies,
  REFRESH_COOKIE,
  setAuthCookies,
} from './auth-cookies';
import {
  AuthService,
  GoogleSignInError,
  RefreshRaceError,
} from './auth.service';
import { LoginDto, RegisterDto } from './dto/auth.dto';
import { GoogleAuthGuard } from './google-auth.guard';
import {
  clearGoogleStateCookie,
  googleIntent,
  googleNextPath,
  safeNextPath,
} from './google-oauth-state';
import type { GoogleProfile } from './google.strategy';
import { ReauthService } from './reauth.service';

const refreshTokenOf = (req: Request) =>
  (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];

// Frontend pages the Google flow lands on. `next` survives the round trip so the
// user ends up where they were going (e.g. an invite link).
const frontendCallbackUrl = (next: string) =>
  `${env.frontendUrl}/auth/callback?next=${encodeURIComponent(next)}`;

/** Back to Settings after a re-authentication round trip: ok or an error code */
const reauthResultUrl = (result: string) =>
  `${env.frontendUrl}/settings?reauth=${encodeURIComponent(result)}`;

const loginErrorUrl = (code: GoogleSignInError['code'], next: string) =>
  `${env.frontendUrl}/login?error=${code}&next=${encodeURIComponent(next)}`;

// Tokens only ever travel in httpOnly cookies — response bodies carry just the user.
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly reauth: ReauthService,
  ) {}

  @Public()
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, ...tokens } = await this.auth.register(dto, userAgent);
    setAuthCookies(res, tokens);
    return { user };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, ...tokens } = await this.auth.login(dto, userAgent);
    setAuthCookies(res, tokens);
    return { user };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const { user, ...tokens } = await this.auth.refresh(
        refreshTokenOf(req),
        userAgent,
      );
      setAuthCookies(res, tokens);
      return { user };
    } catch (error) {
      // Losing a refresh race to another tab: that tab's response already set fresh
      // cookies in this same browser — clearing them here would log the user out
      if (!(error instanceof RefreshRaceError)) clearAuthCookies(res);
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(refreshTokenOf(req));
    clearAuthCookies(res);
  }

  /** Signed-in only: ends the user's sessions on every other device; this one stays */
  @Post('logout-all')
  @HttpCode(204)
  @RateLimit('sessions')
  async logoutAll(@CurrentUser() user: AuthUser) {
    await this.auth.logoutAll(user);
  }

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    return { user: await this.auth.me(user.id) };
  }

  // Google sign-in is a browser navigation (a plain link to /api/auth/google),
  // so both routes answer with redirects, never JSON.

  @Public()
  @Get('google')
  @UseGuards(GoogleAuthGuard)
  googleStart(@Req() req: Request, @Res() res: Response) {
    // The guard has already redirected to Google — reached only when it is not configured
    res.redirect(loginErrorUrl('google', safeNextPath(req.query.next)));
  }

  @Public()
  @Get('google/callback')
  @UseGuards(GoogleAuthGuard)
  async googleCallback(
    @Req() req: Request,
    @Headers('user-agent') userAgent: string | undefined,
    @Res() res: Response,
  ) {
    const next = googleNextPath(req);
    const intent = googleIntent(req);
    // One-time flow cookies — also on paths where passport never checked state (Cancel)
    clearGoogleStateCookie(res);

    const profile = req.user as GoogleProfile | null | undefined;

    if (intent === 'reauth') return this.finishReauth(req, res, profile);

    if (!profile) return res.redirect(loginErrorUrl('google', next));

    try {
      const { user: _user, ...tokens } = await this.auth.loginWithGoogle(
        profile,
        userAgent,
      );
      setAuthCookies(res, tokens);
      res.redirect(frontendCallbackUrl(next));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Google sign-in rejected — ${reason}`);
      res.redirect(
        loginErrorUrl(
          error instanceof GoogleSignInError ? error.code : 'google',
          next,
        ),
      );
    }
  }

  /**
   * End of an ?intent=reauth round trip: no session is created or switched. On
   * success the browser gets a short-lived reauth grant (see ReauthService) and
   * returns to Settings; on failure Settings shows why.
   */
  private async finishReauth(
    req: Request,
    res: Response,
    profile: GoogleProfile | null | undefined,
  ) {
    if (!profile) return res.redirect(reauthResultUrl('google'));

    try {
      const userId = await this.auth.reauthenticateWithGoogle(
        profile,
        refreshTokenOf(req),
      );
      await this.reauth.grant(res, userId);
      res.redirect(reauthResultUrl('ok'));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Google re-authentication rejected — ${reason}`);
      res.redirect(
        reauthResultUrl(
          error instanceof GoogleSignInError ? error.code : 'google',
        ),
      );
    }
  }
}
