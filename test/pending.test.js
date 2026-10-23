import test from 'node:test';
import assert from 'node:assert/strict';
import { cancelPending, confirmPending, getPending, setPending } from '../src/pending.js';

test.beforeEach(() => cancelPending());

test('requires explicit confirmation and calls creation once', async () => {
  const pending = { preview: { command: { type: 'expense' } }, mapped: { accountId: 'bradesco' } };
  setPending(pending);
  let calls = 0;
  const result = await confirmPending(async (value) => { calls += 1; assert.equal(value, pending); return ['transaction-1']; });
  assert.equal(calls, 1);
  assert.deepEqual(result, { transaction: pending, result: ['transaction-1'] });
  assert.equal(getPending(), null);
});

test('cancellation clears pending without calling creation', async () => {
  setPending({ mapped: {} });
  assert.equal(cancelPending(), true);
  await assert.rejects(() => confirmPending(async () => { throw new Error('must not run'); }), /nenhuma movimentação pendente/);
});

test('repeated confirmation cannot create duplicates', async () => {
  setPending({ mapped: {} });
  let calls = 0;
  await confirmPending(async () => { calls += 1; return []; });
  await assert.rejects(() => confirmPending(async () => { calls += 1; return []; }), /nenhuma movimentação pendente/);
  assert.equal(calls, 1);
});

test('creation failure clears pending', async () => {
  setPending({ mapped: {} });
  await assert.rejects(() => confirmPending(async () => { throw new Error('Actual unavailable'); }), /Actual unavailable/);
  assert.equal(getPending(), null);
});

test('confirmation in progress rejects a second confirmation', async () => {
  setPending({ mapped: {} });
  let release;
  const first = confirmPending(() => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(() => confirmPending(async () => []), /confirmação em andamento/);
  release([]);
  await first;
});
