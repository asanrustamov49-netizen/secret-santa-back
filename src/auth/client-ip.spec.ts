import {
  CLIENT_IP_HEADER,
  CLIENT_IP_SIGNATURE_HEADER,
  inspectClientIp,
  ipBucketKey,
  normalizeIp,
  signClientIp,
  verifyClientIp,
} from './client-ip';

// The trust rules for the visitor's IP: only a fresh signature made with our secret counts.

const SECRET = 'unit-test-client-ip-secret';
const NOW = 1_800_000_000_000; // ms
const NOW_S = NOW / 1000;

const signed = (ip: string, timestamp = NOW_S, secret = SECRET) => ({
  [CLIENT_IP_HEADER]: ip,
  [CLIENT_IP_SIGNATURE_HEADER]: `${timestamp}.${signClientIp(ip, timestamp, secret)}`,
});

describe('verifyClientIp', () => {
  it('accepts a fresh signature over the IP', () => {
    expect(verifyClientIp(signed('203.0.113.7'), SECRET, NOW)).toBe(
      '203.0.113.7',
    );
    expect(verifyClientIp(signed('2001:db8::1'), SECRET, NOW)).toBe(
      '2001:db8::1',
    );
  });

  it('accepts clock skew up to 60 s either way, and nothing beyond', () => {
    expect(verifyClientIp(signed('203.0.113.7', NOW_S - 60), SECRET, NOW)).toBe(
      '203.0.113.7',
    );
    expect(verifyClientIp(signed('203.0.113.7', NOW_S + 60), SECRET, NOW)).toBe(
      '203.0.113.7',
    );
    expect(
      verifyClientIp(signed('203.0.113.7', NOW_S - 61), SECRET, NOW),
    ).toBeNull();
    expect(
      verifyClientIp(signed('203.0.113.7', NOW_S + 61), SECRET, NOW),
    ).toBeNull();
  });

  it('rejects a signature made with another secret', () => {
    expect(
      verifyClientIp(signed('203.0.113.7', NOW_S, 'other'), SECRET, NOW),
    ).toBeNull();
  });

  it('rejects a signature moved to another IP', () => {
    const headers = {
      ...signed('203.0.113.7'),
      [CLIENT_IP_HEADER]: '198.51.100.1',
    };
    expect(verifyClientIp(headers, SECRET, NOW)).toBeNull();
  });

  it('rejects a changed timestamp', () => {
    const headers = signed('203.0.113.7');
    const [, mac] = headers[CLIENT_IP_SIGNATURE_HEADER].split('.');
    headers[CLIENT_IP_SIGNATURE_HEADER] = `${NOW_S - 1}.${mac}`;
    expect(verifyClientIp(headers, SECRET, NOW)).toBeNull();
  });

  it('trusts nothing without a secret, without headers, or with malformed ones', () => {
    expect(verifyClientIp(signed('203.0.113.7'), undefined, NOW)).toBeNull();
    expect(verifyClientIp({}, SECRET, NOW)).toBeNull();
    expect(
      verifyClientIp({ [CLIENT_IP_HEADER]: '203.0.113.7' }, SECRET, NOW),
    ).toBeNull();
    expect(
      verifyClientIp(
        { ...signed('203.0.113.7'), [CLIENT_IP_SIGNATURE_HEADER]: 'nonsense' },
        SECRET,
        NOW,
      ),
    ).toBeNull();
    // Not an IP at all, even when "signed"
    expect(verifyClientIp(signed('not-an-ip'), SECRET, NOW)).toBeNull();
    // A header sent twice arrives as an array — never trusted
    expect(
      verifyClientIp(
        {
          ...signed('203.0.113.7'),
          [CLIENT_IP_HEADER]: ['203.0.113.7', '1.1.1.1'],
        },
        SECRET,
        NOW,
      ),
    ).toBeNull();
  });

  it('ignores X-Forwarded-For entirely', () => {
    expect(
      verifyClientIp({ 'x-forwarded-for': '203.0.113.7' }, SECRET, NOW),
    ).toBeNull();
  });
});

describe('inspectClientIp — why a request is trusted or not', () => {
  const status = (
    headers: Record<string, string>,
    secret: string | undefined = SECRET,
    now = NOW,
  ) => inspectClientIp(headers, secret, now).status;

  it('matching secret on both sides: valid, with the IP', () => {
    expect(inspectClientIp(signed('203.0.113.7'), SECRET, NOW)).toEqual({
      status: 'valid',
      ip: '203.0.113.7',
    });
  });

  it('different secret on the proxy: invalid, no IP', () => {
    const fromProxy = signed('203.0.113.7', NOW_S, 'the-secret-set-on-vercel');
    expect(inspectClientIp(fromProxy, SECRET, NOW)).toEqual({
      status: 'invalid',
      ip: null,
    });
  });

  it('no secret on this API: not_configured, whatever the headers say', () => {
    // (called directly: undefined as an argument would fall back to the helper's default)
    for (const headers of [signed('203.0.113.7'), {}]) {
      expect(inspectClientIp(headers, undefined, NOW).status).toBe(
        'not_configured',
      );
    }
  });

  it('no signature headers at all: missing', () => {
    expect(status({})).toBe('missing');
    expect(status({ 'x-forwarded-for': '198.51.100.1' })).toBe('missing');
  });

  it('a genuine but old signature is expired; a tampered one is invalid', () => {
    expect(status(signed('203.0.113.7', NOW_S - 61))).toBe('expired');
    expect(status(signed('203.0.113.7', NOW_S + 61))).toBe('expired');
    const forged = {
      ...signed('203.0.113.7'),
      [CLIENT_IP_HEADER]: '198.51.100.1',
    };
    expect(status(forged)).toBe('invalid');
    expect(status({ [CLIENT_IP_HEADER]: '203.0.113.7' })).toBe('invalid');
  });
});

describe('normalizeIp', () => {
  it('keeps IPv4 as is', () => {
    expect(normalizeIp('203.0.113.7')).toBe('203.0.113.7');
  });

  it('counts IPv6 by its /64', () => {
    expect(normalizeIp('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(normalizeIp('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff')).toBe(
      '2001:db8:1:2::/64',
    );
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(normalizeIp('::1')).toBe('0:0:0:0::/64');
  });

  it('treats IPv4-mapped IPv6 as the IPv4 address', () => {
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });
});

describe('ipBucketKey', () => {
  it('is the same for one /64 and differs between visitors', () => {
    expect(ipBucketKey('2001:db8:1:2::1', SECRET)).toBe(
      ipBucketKey('2001:db8:1:2::ffff', SECRET),
    );
    expect(ipBucketKey('203.0.113.7', SECRET)).not.toBe(
      ipBucketKey('203.0.113.8', SECRET),
    );
  });

  it('never contains the IP itself', () => {
    const key = ipBucketKey('203.0.113.7', SECRET);
    expect(key).not.toContain('203');
    expect(key).toHaveLength(32);
  });
});
