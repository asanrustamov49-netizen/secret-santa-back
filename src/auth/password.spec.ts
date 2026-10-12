import { ServiceUnavailableException } from '@nestjs/common';
import {
  createConcurrencyLimiter,
  hashPassword,
  SCRYPT_MAX_CONCURRENT,
  SCRYPT_MAX_QUEUED,
  verifyPassword,
} from './password';

// The scrypt semaphore, and that hashing itself is unchanged by it.

/** A task the test finishes by hand */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('createConcurrencyLimiter', () => {
  const full = () => new Error('full');

  it('runs at most maxRunning at once and starts the queued ones in order', async () => {
    const limiter = createConcurrencyLimiter(2, 10, full);
    const tasks = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = tasks.map((task, i) =>
      limiter.run(() => {
        started.push(i);
        return task.promise;
      }),
    );

    await tick();
    expect(started).toEqual([0, 1]);
    expect(limiter.stats()).toEqual({ running: 2, queued: 2 });

    tasks[1].resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    expect(limiter.stats()).toEqual({ running: 2, queued: 1 });

    tasks[0].resolve();
    tasks[2].resolve();
    tasks[3].resolve();
    await Promise.all(runs);
    expect(started).toEqual([0, 1, 2, 3]);
    expect(limiter.stats()).toEqual({ running: 0, queued: 0 });
  });

  it('refuses at once when the queue is full', async () => {
    const limiter = createConcurrencyLimiter(1, 1, full);
    const first = deferred();
    const second = deferred();
    const a = limiter.run(() => first.promise);
    const b = limiter.run(() => second.promise);

    await expect(limiter.run(() => Promise.resolve())).rejects.toThrow('full');

    first.resolve();
    second.resolve();
    await Promise.all([a, b]);
  });

  it('frees the slot when a task fails', async () => {
    const limiter = createConcurrencyLimiter(1, 1, full);
    const failing = deferred();
    const a = limiter.run(() => failing.promise);
    const b = limiter.run(() => Promise.resolve('next'));

    failing.reject(new Error('boom'));
    await expect(a).rejects.toThrow('boom');
    await expect(b).resolves.toBe('next');
    expect(limiter.stats()).toEqual({ running: 0, queued: 0 });
  });
});

describe('password hashing behind the semaphore', () => {
  it('keeps the same scrypt parameters and still verifies', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(hash.startsWith('scrypt$32768$8$1$')).toBe(true);
    await expect(
      verifyPassword('correct-horse-battery-staple', hash),
    ).resolves.toBe(true);
    await expect(verifyPassword('wrong', hash)).resolves.toBe(false);
  });

  it('answers 503 once 2 are running and 32 are waiting', async () => {
    const total = SCRYPT_MAX_CONCURRENT + SCRYPT_MAX_QUEUED + 1;
    const results = await Promise.allSettled(
      Array.from({ length: total }, () => hashPassword('flood')),
    );
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ServiceUnavailableException,
    );
  }, 60_000);
});
