import { jest } from '@jest/globals';
import {
  type ExecutionContext,
  HttpException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { env } from '../config/env';
import { AuthRateLimit, AuthRateLimitGuard } from './auth-rate-limit';
import {
  CLIENT_IP_HEADER,
  CLIENT_IP_SIGNATURE_HEADER,
  ipBucketKey,
  signClientIp,
} from './client-ip';

// The guard reads env on every call: a known secret and small limits for these tests
const SECRET = 'unit-test-client-ip-secret';
env.clientIpSigningSecret = SECRET;
env.authRateLimits.login = { limit: 3, unverifiedLimit: 2, windowSeconds: 900 };

// The guard on /auth/login and /auth/register, against a stand-in for the PostgreSQL counter.

class Routes {
  @AuthRateLimit('login')
  login() {}

  other() {}
}

function setup(hits: number | Error) {
  const hit = jest.fn((_bucket: string, _windowSeconds: number) =>
    hits instanceof Error
      ? Promise.reject(hits)
      : Promise.resolve({ hits, resetAt: new Date(Date.now() + 120_000) }),
  );
  const guard = new AuthRateLimitGuard(new Reflector(), { hit } as never);
  return { guard, hit };
}

function context(handler: () => void, headers: Record<string, string> = {}) {
  const setHeader = jest.fn();
  const ctx = {
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
      getResponse: () => ({ setHeader }),
    }),
  } as unknown as ExecutionContext;
  return { ctx, setHeader };
}

function signedHeaders(ip: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    [CLIENT_IP_HEADER]: ip,
    [CLIENT_IP_SIGNATURE_HEADER]: `${timestamp}.${signClientIp(ip, timestamp, SECRET)}`,
  };
}

describe('AuthRateLimitGuard', () => {
  it('counts a signed IP in its own bucket, with the per-IP limit', async () => {
    const { guard, hit } = setup(3);
    const { ctx } = context(
      Routes.prototype.login,
      signedHeaders('203.0.113.7'),
    );

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const key = ipBucketKey('203.0.113.7', SECRET);
    expect(hit).toHaveBeenCalledWith(`login:ip:${key}`, 900);
  });

  it('answers 429 with Retry-After once the limit is passed', async () => {
    const { guard } = setup(4);
    const { ctx, setHeader } = context(
      Routes.prototype.login,
      signedHeaders('203.0.113.7'),
    );

    const error = await guard.canActivate(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    const [name, value] = setHeader.mock.calls[0] as [string, string];
    expect(name).toBe('Retry-After');
    expect(Number(value)).toBeGreaterThan(0);
  });

  it('puts unsigned requests in the shared bucket, with its own limit', async () => {
    const { guard, hit } = setup(3);
    // A forged X-Forwarded-For changes nothing
    const { ctx } = context(Routes.prototype.login, {
      'x-forwarded-for': '198.51.100.1',
    });

    const error = await guard.canActivate(ctx).catch((e: unknown) => e);
    expect(hit).toHaveBeenCalledWith('login:unverified', 900);
    expect((error as HttpException).getStatus()).toBe(429); // 3 > unverified limit 2
  });

  it('never stores the raw IP in the bucket', async () => {
    const { guard, hit } = setup(1);
    await guard.canActivate(
      context(Routes.prototype.login, signedHeaders('203.0.113.7')).ctx,
    );
    expect(hit.mock.calls[0][0]).not.toContain('203.0.113.7');
  });

  it('fails closed with a plain 503 when the count cannot be taken', async () => {
    const { guard } = setup(
      new Error('relation "auth_rate_limits" does not exist'),
    );
    const { ctx } = context(
      Routes.prototype.login,
      signedHeaders('203.0.113.7'),
    );

    const error = await guard.canActivate(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as HttpException).message).toBe(
      'Service temporarily unavailable',
    );
  });

  it('a proxy with another secret lands in the shared bucket, with one quiet warning', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const { guard, hit } = setup(1);
    const timestamp = Math.floor(Date.now() / 1000);
    const wrongSecret = 'the-value-someone-set-on-vercel';
    const headers = {
      [CLIENT_IP_HEADER]: '203.0.113.7',
      [CLIENT_IP_SIGNATURE_HEADER]: `${timestamp}.${signClientIp('203.0.113.7', timestamp, wrongSecret)}`,
    };

    for (let i = 0; i < 3; i++) {
      await guard.canActivate(context(Routes.prototype.login, headers).ctx);
    }

    expect(hit.mock.calls.map(([bucket]) => bucket)).toEqual([
      'login:unverified',
      'login:unverified',
      'login:unverified',
    ]);
    // Once per minute at most, and nothing that identifies the visitor or either key
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0][0]);
    expect(logged).toContain('invalid');
    for (const secretOrIp of [SECRET, wrongSecret, '203.0.113.7']) {
      expect(logged).not.toContain(secretOrIp);
    }
    warn.mockRestore();
  });

  it('the same secret on both sides counts per visitor, without warnings', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const { guard, hit } = setup(1);
    await guard.canActivate(
      context(Routes.prototype.login, signedHeaders('198.51.100.20')).ctx,
    );
    expect(hit.mock.calls[0][0]).toBe(
      `login:ip:${ipBucketKey('198.51.100.20', SECRET)}`,
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('lets sign-in through, loudly, when migration 007 was never applied', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const missingTable = Object.assign(
      new Error('relation "auth_rate_limits" does not exist'),
      { code: '42P01' },
    );
    const { guard } = setup(missingTable);
    const { ctx } = context(
      Routes.prototype.login,
      signedHeaders('203.0.113.7'),
    );

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // Once a minute, naming the fix — the limits are off, nobody is locked out
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain(
      '007_auth_rate_limits.sql',
    );
    error.mockRestore();
  });

  it('leaves routes without @AuthRateLimit alone', async () => {
    const { guard, hit } = setup(1000);
    await expect(
      guard.canActivate(context(Routes.prototype.other).ctx),
    ).resolves.toBe(true);
    expect(hit).not.toHaveBeenCalled();
  });
});
