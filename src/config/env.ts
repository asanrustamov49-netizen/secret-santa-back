import { existsSync, readFileSync } from 'node:fs';

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
