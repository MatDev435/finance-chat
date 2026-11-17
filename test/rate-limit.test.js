import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/rate-limit.js';

test('blocks after the limit and unblocks when the window ends', () => {
  const clock = { now: 0 };
  const limiter = createRateLimiter({ limit: 3, windowMs: 1000, now: () => clock.now });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(limiter.check('user:ana').allowed, true);
    limiter.hit('user:ana');
  }
  assert.deepEqual(limiter.check('user:ana'), { allowed: false, retryAfterMs: 1000 });
  assert.equal(limiter.check('user:bia').allowed, true);
  clock.now = 1000;
  assert.equal(limiter.check('user:ana').allowed, true);
});

test('reset clears a key', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
  limiter.hit('k');
  assert.equal(limiter.check('k').allowed, false);
  limiter.reset('k');
  assert.equal(limiter.check('k').allowed, true);
});

test('memory stays bounded under many distinct keys', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 50 });
  for (let index = 0; index < 500; index += 1) limiter.hit(`ip:${index}`);
  assert.ok(limiter.size <= 50);
});
