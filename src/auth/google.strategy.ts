import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, type Profile } from 'passport-google-oauth20';
import { env } from '../config/env';
import { googleStateStore } from './google-oauth-state';

/** What we keep from Google's userinfo — raw, normalized later in AuthService */
export interface GoogleProfile {
  googleId: string;
  email: string | undefined;
  emailVerified: boolean;
  name: string | undefined;
  picture: string | undefined;
}

/** Registered only when env.google is set (see AuthModule) */
@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor() {
    const google = env.google!;
    super({
      clientID: google.clientId,
      clientSecret: google.clientSecret,
      callbackURL: google.callbackUrl,
      scope: ['profile', 'email'],
      store: googleStateStore,
    });
  }

  // Google's access/refresh tokens are dropped here on purpose: Google only
  // proves who the user is, our own session takes over from there.
  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
  ): GoogleProfile {
    const json = profile._json;
    return {
      googleId: profile.id,
      email: json.email,
      emailVerified: String(json.email_verified) === 'true',
      name: json.name ?? profile.displayName,
      picture: json.picture,
    };
  }
}
