import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * The visitor's IP for sign-in limits — trusted only when the Next.js proxy signed it.
 *
 * X-Forwarded-For and req.ip are never used: the browser reaches this API through the
 * Next.js /api rewrite, so req.ip is Vercel's address and X-Forwarded-For carries
 * whatever the client sent. Instead, src/proxy.ts on Vercel reads the IP Vercel itself
 * observed and signs it with CLIENT_IP_SIGNING_SECRET (HMAC-SHA256):
 *
 *   x-santa-client-ip:     <ip>
 *   x-santa-client-ip-sig: <unix seconds>.<base64url HMAC of "v1\n<ts>\n<ip>">
 *
 * Without a valid, fresh signature the request has no trusted IP and is counted in
 * the shared "unverified" bucket. The raw IP never leaves this file except as the
 * return value of verifyClientIp; buckets hold only a keyed hash of it.
 */
export const CLIENT_IP_HEADER = 'x-santa-client-ip';
export const CLIENT_IP_SIGNATURE_HEADER = 'x-santa-client-ip-sig';

/** How far the signature's timestamp may be from now, either way (clock skew + transit) */
export const SIGNATURE_MAX_AGE_SECONDS = 60;

const SIGNATURE = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

/** What is signed — the same string the frontend builds (src/lib/security/clientIp.ts) */
const payload = (timestamp: number, ip: string) => `v1\n${timestamp}\n${ip}`;

export function signClientIp(ip: string, timestamp: number, secret: string) {
  return createHmac('sha256', secret)
    .update(payload(timestamp, ip))
    .digest('base64url');
}

const single = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;

/**
 * What a request's IP headers amount to:
 * - not_configured — this API has no secret, so nothing can be trusted
 * - missing        — no signature at all (a direct call to the API, or the proxy didn't sign)
 * - invalid        — malformed, or signed with another key: a forged header — or, when
 *                    every request shows it, CLIENT_IP_SIGNING_SECRET differs on Vercel and here
 * - expired        — a correct signature from more than SIGNATURE_MAX_AGE_SECONDS away
 *                    (a replay, or the two clocks disagree)
 * - valid          — signed by the proxy just now; `ip` is the visitor's address
 */
export type ClientIpStatus =
  'not_configured' | 'missing' | 'invalid' | 'expired' | 'valid';

export function inspectClientIp(
  headers: Record<string, string | string[] | undefined>,
  secret: string | undefined,
  nowMs: number,
): { status: ClientIpStatus; ip: string | null } {
  const refuse = (status: ClientIpStatus) => ({ status, ip: null });
  if (!secret) return refuse('not_configured');

  const rawIp = headers[CLIENT_IP_HEADER];
  const rawSignature = headers[CLIENT_IP_SIGNATURE_HEADER];
  if (rawIp === undefined && rawSignature === undefined)
    return refuse('missing');

  const ip = single(rawIp)?.trim();
  const signature = single(rawSignature)?.trim();
  if (!ip || !signature || ip.length > 64 || isIP(ip) === 0) {
    return refuse('invalid');
  }

  const match = SIGNATURE.exec(signature);
  if (!match) return refuse('invalid');
  const timestamp = Number(match[1]);

  const expected = Buffer.from(signClientIp(ip, timestamp, secret));
  const actual = Buffer.from(match[2]);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return refuse('invalid');
  }
  // Checked after the signature: only a genuine but old one counts as "expired"
  if (Math.abs(nowMs / 1000 - timestamp) > SIGNATURE_MAX_AGE_SECONDS) {
    return refuse('expired');
  }
  return { status: 'valid', ip };
}

/**
 * The client IP if the headers carry a valid signature made within
 * SIGNATURE_MAX_AGE_SECONDS of `nowMs`; null for anything else.
 */
export function verifyClientIp(
  headers: Record<string, string | string[] | undefined>,
  secret: string | undefined,
  nowMs: number,
): string | null {
  return inspectClientIp(headers, secret, nowMs).ip;
}

/** "1:2::3" → its 8 groups as numbers; an embedded IPv4 tail counts as two groups */
function ipv6Groups(ip: string): number[] {
  let address = ip.toLowerCase().split('%')[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (v4) {
    const [a, b, c, d] = v4[1].split('.').map(Number);
    address = `${address.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = address.split('::');
  const parse = (part: string | undefined) =>
    part ? part.split(':').map((group) => parseInt(group, 16)) : [];
  const front = parse(head);
  const back = parse(tail);
  const zeros =
    tail === undefined ? [] : Array(8 - front.length - back.length).fill(0);
  return [...front, ...zeros, ...back];
}

/**
 * What one visitor is counted as: an IPv4 address as is, an IPv6 address as its /64 —
 * one home or phone gets a whole /64, so counting single IPv6 addresses would let
 * anyone rotate through millions of them. IPv4-mapped IPv6 counts as the IPv4.
 */
export function normalizeIp(ip: string): string {
  if (isIP(ip) === 4) return ip;
  const groups = ipv6Groups(ip);
  const isMappedV4 =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isMappedV4) {
    return [
      groups[6] >> 8,
      groups[6] & 0xff,
      groups[7] >> 8,
      groups[7] & 0xff,
    ].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

/** The bucket part for one visitor: a keyed hash, so no IP is ever stored */
export function ipBucketKey(ip: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`rate-limit\n${normalizeIp(ip)}`)
    .digest('base64url')
    .slice(0, 32);
}
