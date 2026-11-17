import test from 'node:test';
import assert from 'node:assert/strict';
import { PENDING_TTL_MS, createPendingStore } from '../src/pending.js';

test('requires explicit confirmation and can be taken only once', () => {
  const store = createPendingStore();
  const { id } = store.put(1, 'acc-a', { mapped: { accountId: 'acc-a' } });
  assert.deepEqual(store.take(1, id), { mapped: { accountId: 'acc-a' }, accountId: 'acc-a' });
  assert.throws(() => store.take(1, id), { code: 'NO_PENDING_TRANSACTION' });
});

test('cancellation clears the pending preview', () => {
  const store = createPendingStore();
  const { id } = store.put(1, 'acc-a', {});
  assert.equal(store.cancel(1, id), true);
  assert.equal(store.cancel(1, id), false);
  assert.throws(() => store.take(1, id), { code: 'NO_PENDING_TRANSACTION' });
});

test('a user cannot confirm or cancel another user\'s preview', () => {
  const store = createPendingStore();
  const { id } = store.put(1, 'acc-a', {});
  assert.throws(() => store.take(2, id), { code: 'NO_PENDING_TRANSACTION' });
  assert.equal(store.cancel(2, id), false);
  assert.deepEqual(store.take(1, id), { accountId: 'acc-a' });
});

test('a new preview replaces the previous one of the same chat only', () => {
  const store = createPendingStore();
  const first = store.put(1, 'acc-a', { n: 1 });
  const other = store.put(1, 'acc-b', { n: 2 });
  const second = store.put(1, 'acc-a', { n: 3 });
  assert.throws(() => store.take(1, first.id), { code: 'NO_PENDING_TRANSACTION' });
  assert.equal(store.take(1, other.id).n, 2);
  assert.equal(store.take(1, second.id).n, 3);
});

test('expired previews cannot be confirmed and are pruned', () => {
  const clock = { now: 0 };
  const store = createPendingStore({ now: () => clock.now });
  const stale = store.put(1, 'acc-a', {});
  clock.now = PENDING_TTL_MS;
  assert.throws(() => store.take(1, stale.id), { code: 'PENDING_EXPIRED' });
  store.put(2, 'acc-b', {});
  const old = store.put(3, 'acc-c', {});
  clock.now += PENDING_TTL_MS;
  store.put(4, 'acc-d', {});
  assert.equal(store.size, 1);
  assert.throws(() => store.take(3, old.id), { code: 'NO_PENDING_TRANSACTION' });
});

test('rejects malformed ids', () => {
  const store = createPendingStore();
  assert.throws(() => store.take(1, undefined), { code: 'NO_PENDING_TRANSACTION' });
  assert.throws(() => store.take(1, { id: 'x' }), { code: 'NO_PENDING_TRANSACTION' });
});
