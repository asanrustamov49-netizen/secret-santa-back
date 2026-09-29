import { Test } from '@nestjs/testing';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuthController } from './../src/auth/auth.controller';
import { AuthService } from './../src/auth/auth.service';
import { GoogleAuthGuard } from './../src/auth/google-auth.guard';
import { ReauthService } from './../src/auth/reauth.service';
import { SessionsService } from './../src/auth/sessions.service';
import type { GoogleProfile } from './../src/auth/google.strategy';
import { DatabaseService } from './../src/database/database.service';
import { UsersService, type UserRecord } from './../src/users/users.service';

// Regression: a Google sign-in must never be linked to an existing account just
// because the email matches. Email/password sign-up doesn't prove the address is
// yours, so auto-linking let someone pre-register a victim's email, wait for the
// victim to "Continue with Google", and keep signing in with their own password.
//
// Real AuthController + AuthService over HTTP; the database is an in-memory fake
// and Google is stubbed at the guard — no real DB rows, no network.

const CALLBACK = '/api/auth/google/callback';

function makeUser(overrides: Partial<UserRecord>): UserRecord {
  return {
    id: crypto.randomUUID(),
    email: 'someone@example.com',
    name: 'Someone',
    passwordHash: null,
    googleId: null,
    avatarUrl: null,
    interests: [],
    themePreference: 'system',
    notifyEmail: true,
    notifyReminders: true,
    notifyInvites: true,
    createdAt: new Date(),
    ...overrides,
  };
}

function googleProfile(overrides: Partial<GoogleProfile>): GoogleProfile {
  return {
    googleId: 'google-id',
    email: 'someone@example.com',
    emailVerified: true,
    name: 'Google Name',
    picture: undefined,
    ...overrides,
  };
}

describe('Google sign-in never auto-links by email (e2e)', () => {
  let app: INestApplication<App>;
  let users: UserRecord[];
  let linkCalls: number;
  let sessionsCreated: number;
  let profile: GoogleProfile;

  const fakeUsers = {
    findById: (id: string) =>
      Promise.resolve(users.find((u) => u.id === id) ?? null),
    findByEmail: (email: string) =>
      Promise.resolve(users.find((u) => u.email === email) ?? null),
    findByGoogleId: (googleId: string) =>
      Promise.resolve(users.find((u) => u.googleId === googleId) ?? null),
    createGoogleUser: (data: {
      email: string;
      name: string;
      googleId: string;
      avatarUrl: string | null;
    }) => {
      const user = makeUser(data);
      users.push(user);
      return Promise.resolve(user);
    },
    // Same rule as the real SQL: attach unless linked to a different Google account
    linkGoogleAccount: (userId: string, googleId: string) => {
      linkCalls++;
      const user = users.find((u) => u.id === userId);
      if (!user || (user.googleId && user.googleId !== googleId)) {
        return Promise.resolve(null);
      }
      user.googleId = googleId;
      return Promise.resolve(user);
    },
  };

  const fakeDb = {
    // Only createSession writes (the refresh_tokens insert)
    query: (sql: string) => {
      if (sql.includes('insert into refresh_tokens')) {
        sessionsCreated++;
        return Promise.resolve([{ id: crypto.randomUUID() }]);
      }
      return Promise.resolve([]);
    },
    one: () => Promise.resolve(null),
  };

  beforeEach(async () => {
    users = [];
    linkCalls = 0;
    sessionsCreated = 0;

    const moduleRef = await Test.createTestingModule({
      // AuthController has rate-limited routes (logout-all)
      imports: [ThrottlerModule.forRoot([])],
      controllers: [AuthController],
      providers: [
        AuthService,
        SessionsService,
        ReauthService,
        { provide: UsersService, useValue: fakeUsers },
        { provide: DatabaseService, useValue: fakeDb },
        { provide: JwtService, useValue: new JwtService() },
      ],
    })
      // Stand-in for passport: Google has "returned" this profile
      .overrideGuard(GoogleAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest<{ user: unknown }>().user = profile;
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  /** Names of auth cookies the response actually sets (not the ones it clears) */
  const authCookiesSet = (setCookie: string | string[] | undefined) =>
    ([] as string[])
      .concat(setCookie ?? [])
      .filter((c) => /^(access_token|refresh_token|has_session)=[^;]/.test(c))
      .map((c) => c.split('=')[0]);

  it('refuses a verified Google email that belongs to a password account', async () => {
    // Pre-registered with email + password — nothing proved the mailbox is theirs
    const preRegistered = makeUser({
      email: 'victim@example.com',
      passwordHash: 'scrypt$32768$8$1$c2FsdA==$aGFzaA==',
    });
    users.push(preRegistered);
    // The real mailbox owner signs in with Google (email case differs on purpose)
    profile = googleProfile({
      googleId: 'victims-google-id',
      email: 'Victim@Example.com',
    });

    const res = await request(app.getHttpServer()).get(CALLBACK).expect(302);

    expect(res.headers.location).toContain(
      '/login?error=google_account_exists',
    );
    expect(authCookiesSet(res.headers['set-cookie'])).toEqual([]);
    expect(sessionsCreated).toBe(0);
    expect(linkCalls).toBe(0);
    // The account was left exactly as it was: no Google identity attached
    expect(preRegistered.googleId).toBeNull();
    expect(users).toHaveLength(1);
  });

  it('refuses an email already used by a different Google account', async () => {
    users.push(
      makeUser({ email: 'shared@example.com', googleId: 'first-google-id' }),
    );
    profile = googleProfile({
      googleId: 'second-google-id',
      email: 'shared@example.com',
    });

    const res = await request(app.getHttpServer()).get(CALLBACK).expect(302);

    expect(res.headers.location).toContain(
      '/login?error=google_account_exists',
    );
    expect(authCookiesSet(res.headers['set-cookie'])).toEqual([]);
    expect(linkCalls).toBe(0);
    expect(users).toHaveLength(1);
  });

  it('still signs in a returning Google user by google id', async () => {
    users.push(
      makeUser({ email: 'returning@example.com', googleId: 'returning-id' }),
    );
    profile = googleProfile({
      googleId: 'returning-id',
      email: 'returning@example.com',
    });

    const res = await request(app.getHttpServer()).get(CALLBACK).expect(302);

    expect(res.headers.location).toContain('/auth/callback');
    expect(authCookiesSet(res.headers['set-cookie']).sort()).toEqual([
      'access_token',
      'has_session',
      'refresh_token',
    ]);
    expect(sessionsCreated).toBe(1);
    expect(users).toHaveLength(1);
  });

  it('still creates a new account for an email nobody uses', async () => {
    profile = googleProfile({ googleId: 'new-id', email: 'New@Example.com' });

    const res = await request(app.getHttpServer()).get(CALLBACK).expect(302);

    expect(res.headers.location).toContain('/auth/callback');
    expect(sessionsCreated).toBe(1);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      email: 'new@example.com',
      googleId: 'new-id',
      passwordHash: null,
    });
  });
});
