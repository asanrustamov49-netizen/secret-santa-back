import { jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { clientIpSigningSecret, signingSecretProblem } from './signing-secret';

// CLIENT_IP_SIGNING_SECRET: what counts as a usable key, and what the API does without one.

const GOOD_BASE64URL = randomBytes(48).toString('base64url'); // what .env.example tells you to run
const GOOD_HEX = randomBytes(32).toString('hex');

describe('signingSecretProblem', () => {
  it('accepts what the documented generator prints, base64url or hex', () => {
    expect(signingSecretProblem(GOOD_BASE64URL)).toBeNull();
    expect(
      signingSecretProblem(randomBytes(32).toString('base64url')),
    ).toBeNull(); // 43 chars
    expect(signingSecretProblem(GOOD_HEX)).toBeNull();
    expect(signingSecretProblem(`  ${GOOD_BASE64URL}\n`)).toBeNull(); // pasted with a newline
  });

  it('reports a missing secret', () => {
    for (const value of [undefined, '', '   ']) {
      expect(signingSecretProblem(value)).toBe('missing');
    }
  });

  it('refuses anything under 32 bytes', () => {
    expect(signingSecretProblem(randomBytes(31).toString('base64url'))).toBe(
      'too_short',
    );
    expect(signingSecretProblem(randomBytes(31).toString('hex'))).toBe(
      'too_short',
    );
    expect(signingSecretProblem('change-me')).toBe('too_short');
  });

  it('refuses characters a generated key never has', () => {
    expect(signingSecretProblem(`${GOOD_BASE64URL}=`)).toBe('bad_format');
    expect(
      signingSecretProblem('a long passphrase with spaces in it, really'),
    ).toBe('bad_format');
  });

  it('refuses long but obviously non-random keys', () => {
    expect(signingSecretProblem('a'.repeat(64))).toBe('low_variety');
    expect(signingSecretProblem('xyz'.repeat(20))).toBe('low_variety');
    expect(signingSecretProblem('01'.repeat(40))).toBe('low_variety'); // hex, 2 symbols
  });
});

describe('clientIpSigningSecret', () => {
  it('returns a valid secret, trimmed, in any environment', () => {
    expect(clientIpSigningSecret(` ${GOOD_BASE64URL} `, true)).toBe(
      GOOD_BASE64URL,
    );
    expect(clientIpSigningSecret(GOOD_HEX, false)).toBe(GOOD_HEX);
  });

  it('stops the start-up in production when missing, short or weak', () => {
    for (const value of [undefined, '', 'change-me', 'a'.repeat(64)]) {
      expect(() => clientIpSigningSecret(value, true)).toThrow(
        /^CLIENT_IP_SIGNING_SECRET /,
      );
    }
  });

  it('never puts the value into the message', () => {
    const weak = 'my-weak-but-private-secret-value';
    const warn = jest.fn();
    let thrown = '';
    try {
      clientIpSigningSecret(weak, true);
    } catch (error) {
      thrown = (error as Error).message;
    }
    clientIpSigningSecret(weak, false, warn);

    expect(thrown).not.toContain(weak);
    expect(String(warn.mock.calls[0][0])).not.toContain(weak);
  });

  it('keeps local development working: unset is fine, weak only warns', () => {
    const warn = jest.fn();
    expect(clientIpSigningSecret(undefined, false, warn)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();

    expect(clientIpSigningSecret('dev-secret', false, warn)).toBe('dev-secret');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
