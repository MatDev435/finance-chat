import test from 'node:test';
import assert from 'node:assert/strict';
import { UNDO_TTL_MS, createUndoStore } from '../src/undo.js';

test('keeps only the last confirmed transaction of each chat', () => {
  const store = createUndoStore();
  const first = store.put(1, 'acc-a', { transactionId: 't1' });
  const other = store.put(1, 'acc-b', { transactionId: 't2' });
  const second = store.put(1, 'acc-a', { transactionId: 't3' });
  assert.equal(store.latestId(1, 'acc-a'), second.id);
  assert.equal(store.latestId(1, 'acc-b'), other.id);
  assert.throws(() => store.begin(1, first.id), { code: 'NO_UNDO' });
});

test('is single use and blocks a parallel attempt while in progress', () => {
  const store = createUndoStore();
  const { id } = store.put(1, 'acc-a', { transactionId: 't1' });
  assert.equal(store.begin(1, id).transactionId, 't1');
  assert.throws(() => store.begin(1, id), { code: 'NO_UNDO' }, 'double click');
  store.finish(id);
  assert.throws(() => store.begin(1, id), { code: 'NO_UNDO' });
  assert.equal(store.latestId(1, 'acc-a'), null);
});

test('abort makes it available again (nothing was deleted)', () => {
  const store = createUndoStore();
  const { id } = store.put(1, 'acc-a', { transactionId: 't1' });
  store.begin(1, id);
  store.abort(id);
  assert.equal(store.begin(1, id).transactionId, 't1');
});

test('belongs only to its user', () => {
  const store = createUndoStore();
  const { id } = store.put(1, 'acc-a', { transactionId: 't1' });
  assert.throws(() => store.begin(2, id), { code: 'NO_UNDO' });
  assert.equal(store.latestId(2, 'acc-a'), null);
  assert.equal(store.begin(1, id).transactionId, 't1');
});

test('expires after the undo window', () => {
  const clock = { now: 0 };
  const store = createUndoStore({ now: () => clock.now });
  const { id } = store.put(1, 'acc-a', { transactionId: 't1' });
  clock.now = UNDO_TTL_MS;
  assert.equal(store.latestId(1, 'acc-a'), null);
  assert.throws(() => store.begin(1, id), { code: 'UNDO_EXPIRED' });
  assert.equal(store.size, 0);
  assert.throws(() => store.begin(1, undefined), { code: 'NO_UNDO' });
});
