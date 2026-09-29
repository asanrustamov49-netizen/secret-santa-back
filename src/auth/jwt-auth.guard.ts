import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { env } from '../config/env';
import type { AuthedRequest } from '../common/auth/auth.types';
import { IS_PUBLIC_KEY } from '../common/auth/public.decorator';
import { ACCESS_COOKIE } from './auth-cookies';

/**
 * Registered globally (APP_GUARD): secure by default.
 * Reads the access token from the httpOnly cookie, or from
 * "Authorization: Bearer …" for non-browser clients.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = this.extractToken(request);
    if (!token) throw new UnauthorizedException('Not signed in');

    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; sid?: string }>(
        token,
        {
          secret: env.jwtAccessSecret,
        },
      );
      request.user = { id: payload.sub, sessionId: payload.sid };
      return true;
    } catch {
      // The client reacts to 401 by calling /auth/refresh once
      throw new UnauthorizedException('Session expired');
    }
  }

  private extractToken(request: AuthedRequest): string | undefined {
    const fromCookie = (
      request.cookies as Record<string, string> | undefined
    )?.[ACCESS_COOKIE];
    if (fromCookie) return fromCookie;

    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
