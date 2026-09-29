import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { GoogleAuthGuard } from './../src/auth/google-auth.guard';
import type { GoogleProfile } from './../src/auth/google.strategy';
import { DatabaseService } from './../src/database/database.service';

// Shared by the e2e suites that run against the real app and database.
// Every account a suite creates uses its own email prefix and is deleted
// before and after the suite (cascade removes sessions, events, wishlist).

export const PASSWORD = 'correct-horse-battery-staple';

export type Agent = ReturnType<typeof request.agent>;

export interface TestApp {
  app: INestApplication<App>;
  db: DatabaseService;
  /** Google "returns" this profile on /api/auth/google/callback */
  setGoogleProfile(profile: GoogleProfile | null): void;
  cleanup(): Promise<void>;
}

/**
 * The real AppModule. Only Google itself is stubbed: the guard hands the callback
 * whatever profile the test set, as passport would after a real round trip.
 */
export async function createTestApp(
  emailPrefix: string,
  /** Further stand-ins, e.g. the AI provider — no suite ever calls a paid API */
  override: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<TestApp> {
  let googleProfile: GoogleProfile | null = null;

  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideGuard(GoogleAuthGuard)
    .useValue({
      canActivate: (context: ExecutionContext) => {
        context.switchToHttp().getRequest<{ user: unknown }>().user =
          googleProfile;
        return true;
      },
    });
  const moduleRef = await override(builder).compile();

  const app = configureApp(moduleRef.createNestApplication());
  await app.init();
  const db = app.get(DatabaseService);

  const cleanup = async () => {
    await db.query(`delete from users where email like $1`, [
      `${emailPrefix}-%@example.com`,
    ]);
  };
  await cleanup();

  return {
    app,
    db,
    setGoogleProfile: (profile) => (googleProfile = profile),
    cleanup,
  };
}

export const uniqueEmail = (prefix: string) =>
  `${prefix}-${randomUUID()}@example.com`;

/** Cookies a response set, as "name=value" (cleared ones excluded) */
export function cookiesSet(res: request.Response): Record<string, string> {
  const result: Record<string, string> = {};
  for (const cookie of ([] as string[]).concat(
    res.headers['set-cookie'] ?? [],
  )) {
    const [pair] = cookie.split(';');
    const index = pair.indexOf('=');
    const value = pair.slice(index + 1);
    if (value) result[pair.slice(0, index)] = value;
  }
  return result;
}

/** A Cookie header out of name → value pairs */
export const cookieHeader = (cookies: Record<string, string | undefined>) =>
  Object.entries(cookies)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');

export async function activeSessions(db: DatabaseService, userId: string) {
  const [row] = await db.query<{ count: number }>(
    `select count(*)::int as count from refresh_tokens
     where user_id = $1 and revoked_at is null`,
    [userId],
  );
  return row.count;
}

/** A fresh email/password account, signed in on its own cookie jar */
export async function signUp(app: INestApplication<App>, prefix: string) {
  const email = uniqueEmail(prefix);
  const agent = request.agent(app.getHttpServer());
  const res = await agent
    .post('/api/auth/register')
    .send({ name: 'E2E User', email, password: PASSWORD })
    .expect(201);
  const user = (res.body as { user: { id: string } }).user;
  return { agent, email, id: user.id, cookies: cookiesSet(res) };
}

/** A second device: a new session of the same account on its own cookie jar */
export async function logIn(
  app: INestApplication<App>,
  email: string,
  password = PASSWORD,
) {
  const agent = request.agent(app.getHttpServer());
  await agent.post('/api/auth/login').send({ email, password }).expect(200);
  return agent;
}
