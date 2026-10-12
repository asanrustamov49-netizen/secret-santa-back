import { randomBytes, randomInt } from 'node:crypto';
import request from 'supertest';
import {
  CLIENT_IP_HEADER,
  CLIENT_IP_SIGNATURE_HEADER,
  ipBucketKey,
  signClientIp,
} from './../src/auth/client-ip';
import { env } from './../src/config/env';
import { createTestApp, uniqueEmail, type TestApp } from './support';

// Sign-in limits per visitor, against the real app and database (auth_rate_limits,
// migration 007): the signature the Next.js proxy adds, checked by the API, decides
// which counter a request lands in. The secret here is generated for this run only.
// No accounts are created; the counters this suite adds are deleted afterwards.

const PREFIX = 'e2e-clientip';
const SECRET = randomBytes(48).toString('base64url');
const OTHER_SECRET = randomBytes(48).toString('base64url');

/** A fresh documentation-range /64 per run: counters from an earlier run never interfere */
const randomIp = () =>
  `2001:db8:${randomInt(0x10000).toString(16)}:${randomInt(0x10000).toString(16)}::1`;

function signed(
  ip: string,
  secret = SECRET,
  timestamp = Math.floor(Date.now() / 1000),
) {
  return {
    [CLIENT_IP_HEADER]: ip,
    [CLIENT_IP_SIGNATURE_HEADER]: `${timestamp}.${signClientIp(ip, timestamp, secret)}`,
  };
}

describe('Client-IP signature and per-visitor sign-in limits (e2e)', () => {
  let t: TestApp;
  const server = () => t.app.getHttpServer();
  const original = {
    secret: env.clientIpSigningSecret,
    login: env.authRateLimits.login,
  };
  const ips = [randomIp(), randomIp()];

  beforeAll(async () => {
    t = await createTestApp(PREFIX);
    env.clientIpSigningSecret = SECRET;
    // Small per-visitor limit; the shared bucket stays out of the way of other suites
    env.authRateLimits.login = {
      limit: 2,
      unverifiedLimit: 100_000,
      windowSeconds: 900,
    };
  });

  afterAll(async () => {
    env.clientIpSigningSecret = original.secret;
    env.authRateLimits.login = original.login;
    await t.db.query(`delete from auth_rate_limits where bucket = any($1)`, [
      ips.map((ip) => `login:ip:${ipBucketKey(ip, SECRET)}`),
    ]);
    await t.app.close();
  });

  const check = (headers: Record<string, string> = {}) =>
    request(server()).get('/api/auth/client-ip-check').set(headers);

  describe('GET /api/auth/client-ip-check', () => {
    it('reports each case — and nothing but the status', async () => {
      const ip = ips[0];
      const old = Math.floor(Date.now() / 1000) - 120;
      const cases: [Record<string, string>, string][] = [
        [{}, 'missing'],
        [signed(ip), 'valid'],
        [signed(ip, OTHER_SECRET), 'invalid'],
        [signed(ip, SECRET, old), 'expired'],
        [{ ...signed(ip), [CLIENT_IP_HEADER]: '198.51.100.9' }, 'invalid'],
      ];
      for (const [headers, signature] of cases) {
        const res = await check(headers).expect(200);
        expect(res.body).toEqual({ signature });
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.text).not.toContain(ip);
      }
    });

    it('says not_configured when the API has no secret', async () => {
      env.clientIpSigningSecret = undefined;
      try {
        await check(signed(ips[0])).expect(200, {
          signature: 'not_configured',
        });
      } finally {
        env.clientIpSigningSecret = SECRET;
      }
    });
  });

  describe('POST /api/auth/login', () => {
    const attempt = (headers: Record<string, string>) =>
      request(server())
        .post('/api/auth/login')
        .set(headers)
        .send({ email: uniqueEmail(PREFIX), password: 'not-the-password' });

    it('counts each signed visitor apart; forged and foreign signatures change nothing', async () => {
      const [mine, someoneElse] = ips;

      await attempt(signed(mine)).expect(401);
      await attempt(signed(mine)).expect(401);
      const limited = await attempt(signed(mine)).expect(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

      // Another visitor is unaffected
      await attempt(signed(someoneElse)).expect(401);
      // Claiming someone else's IP without the key, or signing with another key:
      // the shared bucket (generous here), never that visitor's counter
      await attempt({
        ...signed(mine),
        [CLIENT_IP_HEADER]: someoneElse,
      }).expect(401);
      await attempt(signed(someoneElse, OTHER_SECRET)).expect(401);

      const rows = await t.db.query<{ bucket: string; hits: number }>(
        `select bucket, hits from auth_rate_limits where bucket = any($1)`,
        [ips.map((ip) => `login:ip:${ipBucketKey(ip, SECRET)}`)],
      );
      const hits = Object.fromEntries(rows.map((r) => [r.bucket, r.hits]));
      expect(hits[`login:ip:${ipBucketKey(mine, SECRET)}`]).toBe(3);
      expect(hits[`login:ip:${ipBucketKey(someoneElse, SECRET)}`]).toBe(1);
      // Only keyed hashes are stored, never an address
      for (const { bucket } of rows) {
        for (const ip of ips) expect(bucket).not.toContain(ip);
      }
    });
  });
});
