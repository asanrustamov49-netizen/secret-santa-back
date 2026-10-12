import { existsSync, readFileSync } from 'node:fs';
import { clientIpSigningSecret } from './signing-secret';

// Load .env into process.env (built into Node >= 20.12, no dotenv needed).
// In production the variables come from the environment itself, so a missing file is fine.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const isProduction = process.env.NODE_ENV === 'production';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env variable: ${name}`);
  return value;
}

/** "true"/"false" (case-insensitive) → boolean; unset → fallback; anything else is a config error */
function boolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(
    `Invalid ${name}: "${process.env[name]}" (expected true or false)`,
  );
}

/**
 * Google sign-in is optional: without a client id/secret the app still starts and
 * /auth/google answers with ?error=google. Setting only part of it is a mistake.
 */
function googleOAuth() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const callbackUrl = process.env.GOOGLE_CALLBACK_URL;

  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret || !callbackUrl) {
    throw new Error(
      'Set all of GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL (or none)',
    );
  }
  return { clientId, clientSecret, callbackUrl };
}

export const AI_PROVIDERS = ['gemini', 'anthropic'] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

/** AI_PROVIDER: gemini (default) or anthropic; anything else is a config error */
function aiProvider(): AiProviderName {
  const value = process.env.AI_PROVIDER?.trim().toLowerCase() || 'gemini';
  if ((AI_PROVIDERS as readonly string[]).includes(value)) {
    return value as AiProviderName;
  }
  throw new Error(
    `Invalid AI_PROVIDER: "${process.env.AI_PROVIDER}" (expected ${AI_PROVIDERS.join(' or ')})`,
  );
}

/** A positive whole number; unset → fallback; anything else is a config error */
function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Invalid ${name}: "${process.env[name]}" (expected a whole number > 0)`,
    );
  }
  return value;
}

/** FRONTEND_URL + CORS_ORIGINS, as bare origins (no path, no trailing slash) */
function corsOrigins(): string[] {
  const frontend =
    process.env.FRONTEND_URL ?? 'https://secret-santa-project-mu.vercel.app';
  const extra = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set([frontend, ...extra].map((url) => new URL(url).origin))];
}

export const env = {
  isProduction,
  port: Number(process.env.PORT ?? 5000),
  frontendUrl:
    process.env.FRONTEND_URL ?? 'https://secret-santa-project-mu.vercel.app',
  /**
   * Browser origins allowed to open the realtime socket: FRONTEND_URL plus any in
   * CORS_ORIGINS (comma-separated, e.g. http://localhost:3000 next to the Vercel site).
   * Never "*": the socket is authenticated.
   */
  corsOrigins: corsOrigins(),

  databaseUrl: required('DATABASE_URL'),
  /** false for local PostgreSQL (no TLS), true for Supabase */
  databaseSsl: boolean('DATABASE_SSL', false),
  /** Optional CA certificate (Supabase → Database settings → SSL) for full verification */
  databaseSslCa: process.env.DATABASE_SSL_CA
    ? readFileSync(process.env.DATABASE_SSL_CA, 'utf8')
    : undefined,

  jwtAccessSecret: required('JWT_ACCESS_SECRET'),
  /** Short-lived: a stolen access token is useful for minutes, not days */
  accessTokenTtlSeconds: 15 * 60,
  refreshTokenTtlDays: 30,

  /**
   * Shared with the Next.js proxy, which signs the visitor's IP (as Vercel saw it)
   * for /auth/login and /auth/register. Required in production, where a missing or
   * weak value stops the start-up (see config/signing-secret.ts); optional elsewhere —
   * then no IP is trusted and all sign-ins share the "unverified" limits. Never logged.
   */
  clientIpSigningSecret: clientIpSigningSecret(
    process.env.CLIENT_IP_SIGNING_SECRET,
    isProduction,
  ),

  /**
   * Sign-in / sign-up limits, counted in PostgreSQL across all API instances.
   * Per signed IP, and for everything without a valid signature together.
   */
  authRateLimits: {
    login: {
      limit: positiveInt('AUTH_LOGIN_LIMIT', 30),
      unverifiedLimit: positiveInt('AUTH_UNVERIFIED_LOGIN_LIMIT', 60),
      windowSeconds: positiveInt('AUTH_LOGIN_WINDOW_SECONDS', 15 * 60),
    },
    register: {
      limit: positiveInt('AUTH_REGISTER_LIMIT', 10),
      unverifiedLimit: positiveInt('AUTH_UNVERIFIED_REGISTER_LIMIT', 20),
      windowSeconds: positiveInt('AUTH_REGISTER_WINDOW_SECONDS', 60 * 60),
    },
  },

  google: googleOAuth(),
  /** How long the user has to finish the Google consent screen */
  googleStateTtlSeconds: 10 * 60,

  /**
   * The AI gift assistant: which model answers, and the keys. The keys are optional:
   * without the active provider's key the app starts as usual and the assistant answers
   * "unavailable". Never logged, never sent to the browser.
   */
  aiProvider: aiProvider(),
  geminiApiKey: process.env.GEMINI_API_KEY?.trim() || undefined,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
};

if (!Number.isInteger(env.port) || env.port <= 0) {
  throw new Error(`Invalid PORT: "${process.env.PORT}"`);
}

if (isProduction && env.jwtAccessSecret.length < 32) {
  throw new Error(
    'JWT_ACCESS_SECRET must be at least 32 characters in production',
  );
}

if (process.env.RENDER === 'true' && !isProduction) {
  // Render sets RENDER=true on its services; without NODE_ENV=production the cookies lose
  // Secure and every production check above (JWT length, CLIENT_IP_SIGNING_SECRET) is off
  console.warn(
    'Running on Render without NODE_ENV=production: cookies are not Secure and production checks are off',
  );
}
