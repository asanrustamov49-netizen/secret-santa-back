/**
 * Rules for CLIENT_IP_SIGNING_SECRET — the HMAC key the Next.js proxy on Vercel signs
 * the visitor's IP with, and this API checks (src/auth/client-ip.ts). The frontend
 * applies the very same rules (src/lib/security/signingSecret.ts) before it signs.
 *
 * Entropy can't be measured from the string, so the format is strict instead: what the
 * documented generator prints — 32+ random bytes, base64url (43+ characters) or hex
 * (64+ characters) — and a variety check that turns away "aaaa…" or "abcabc…" keys.
 *
 *   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
 *
 * Messages name the problem only — never the value, not even its length.
 */
export type SigningSecretProblem =
  'missing' | 'bad_format' | 'too_short' | 'low_variety';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const HEX = /^[0-9a-fA-F]+$/;

/** 32 bytes: 43 base64url characters (6 bits each) or 64 hex characters (4 bits each) */
const MIN_BASE64URL_LENGTH = 43;
const MIN_HEX_LENGTH = 64;
/** Far below what random keys show (≈31 of 64 symbols in 43 characters; ≈16 of 16 in 64) */
const MIN_DISTINCT_BASE64URL = 16;
const MIN_DISTINCT_HEX = 10;

export function signingSecretProblem(
  value: string | undefined,
): SigningSecretProblem | null {
  const secret = value?.trim();
  if (!secret) return 'missing';
  if (!BASE64URL.test(secret)) return 'bad_format';

  const hex = HEX.test(secret);
  if (secret.length < (hex ? MIN_HEX_LENGTH : MIN_BASE64URL_LENGTH)) {
    return 'too_short';
  }
  const distinct = new Set(secret).size;
  if (distinct < (hex ? MIN_DISTINCT_HEX : MIN_DISTINCT_BASE64URL)) {
    return 'low_variety';
  }
  return null;
}

export const SIGNING_SECRET_HINT =
  'expected 32+ random bytes as base64url (43+ characters) or hex (64+ characters): ' +
  `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`;

const DESCRIPTIONS: Record<SigningSecretProblem, string> = {
  missing: 'is not set',
  bad_format: 'is not base64url or hex',
  too_short: 'is too short',
  low_variety: 'is not random enough',
};

/**
 * CLIENT_IP_SIGNING_SECRET as the API uses it.
 *
 * - production: anything but a valid secret stops the start-up. A deploy with a missing,
 *   short or weak key fails at once (Render keeps the previous deploy running) instead
 *   of quietly putting every visitor into the one shared "unverified" sign-in limit.
 * - elsewhere: optional. Unset → undefined (all sign-ins are "unverified", as before);
 *   set but weak → a warning, and it is still used, so local tests keep working.
 */
export function clientIpSigningSecret(
  raw: string | undefined,
  isProduction: boolean,
  warn: (message: string) => void = console.warn,
): string | undefined {
  const problem = signingSecretProblem(raw);
  if (problem === null) return raw!.trim();

  const message = `CLIENT_IP_SIGNING_SECRET ${DESCRIPTIONS[problem]} (${SIGNING_SECRET_HINT})`;
  if (isProduction) throw new Error(message);
  if (problem === 'missing') return undefined;
  warn(`${message} — accepted outside production only`);
  return raw!.trim();
}
