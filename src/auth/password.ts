import { ServiceUnavailableException } from '@nestjs/common';
import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

// scrypt from Node's crypto: memory-hard, no native add-on to install.
// Stored as "scrypt$N$r$p$salt$hash" so parameters can be raised later
// without breaking existing hashes.

const KEY_LENGTH = 64;
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/**
 * Runs at most `maxRunning` tasks at once; up to `maxQueued` more wait their turn
 * (first come, first served). Beyond that a task is refused at once with `onFull()`
 * instead of piling up.
 */
export function createConcurrencyLimiter(
  maxRunning: number,
  maxQueued: number,
  onFull: () => Error,
) {
  let running = 0;
  const waiting: Array<() => void> = [];

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (running < maxRunning) {
        running++;
      } else {
        if (waiting.length >= maxQueued) throw onFull();
        // The finishing task hands its slot straight over, so `running` stays as is
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      try {
        return await task();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else running--;
      }
    },
    /** For tests: how busy it is right now */
    stats: () => ({ running, queued: waiting.length }),
  };
}

/**
 * Every hash and check goes through here: each scrypt takes 32 MB and runs on libuv's
 * small thread pool (4 threads by default, shared with other I/O). Two at a time per
 * instance leaves the rest of the pool free; a flood waits briefly or gets a plain 503.
 */
export const SCRYPT_MAX_CONCURRENT = 2;
export const SCRYPT_MAX_QUEUED = 32;

const scryptSlots = createConcurrencyLimiter(
  SCRYPT_MAX_CONCURRENT,
  SCRYPT_MAX_QUEUED,
  () => new ServiceUnavailableException('Service temporarily unavailable'),
);

function derive(
  password: string,
  salt: Buffer,
  options: ScryptOptions,
): Promise<Buffer> {
  return scryptSlots.run(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        scrypt(password, salt, KEY_LENGTH, options, (error, key) =>
          error ? reject(error) : resolve(key),
        );
      }),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, PARAMS);
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [algorithm, N, r, p, salt, hash] = stored.split('$');
  if (algorithm !== 'scrypt' || !salt || !hash) return false;

  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: PARAMS.maxmem,
  });

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
