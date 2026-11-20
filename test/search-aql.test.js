/**
 * Runs the search queries against the REAL @actual-app/api engine, fully
 * offline: a local budget with fictitious data is created with runImport()
 * in a temporary directory (no server, no network, no real budget). This pins
 * the behavior the search relies on: splits counted once, transfers and the
 * starting balance excluded, one operator per AQL condition, $abs ordering.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFilter, executeSearch, matchPayees } from '../src/search.js';

const api = await import('@actual-app/api');
const dataDir = mkdtempSync(join(tmpdir(), 'finance-chat-aql-'));
const ids = {};

/** The API prints a harmless upload failure when the import finishes without a server. */
async function quietly(task) {
  const { log, error, warn, info } = console;
  console.log = console.error = console.warn = console.info = () => {};
  try {
    return await task();
  } finally {
    Object.assign(console, { log, error, warn, info });
  }
}

test.before(async () => {
  await quietly(async () => {
    await api.init({ dataDir, verbose: false });
    await api.runImport('finance-chat-search-test', async () => {
      ids.checking = await api.createAccount({ name: 'Conta corrente' }, 100000);
      ids.savings = await api.createAccount({ name: 'Poupança' }, 0);
      const group = await api.createCategoryGroup({ name: 'Despesas' });
      ids.food = await api.createCategory({ name: 'Alimentação', group_id: group });
      ids.free = await api.createCategory({ name: 'Livre', group_id: group });
      const transfer = (await api.getPayees()).find((payee) => payee.transfer_acct === ids.savings);
      await api.addTransactions(ids.checking, [
        { date: '2026-08-10', amount: -4000, payee_name: "McDonald's", category: ids.food },
        { date: '2026-10-05', amount: -5000, payee_name: "McDonald's", category: ids.food },
        { date: '2026-10-20', amount: -30000, payee_name: 'Mercado', subtransactions: [{ amount: -15000, category: ids.food }, { amount: -15000, category: ids.free }] },
        { date: '2026-10-31', amount: -2000, payee_name: 'Padaria', category: ids.food },
        { date: '2026-11-01', amount: -1000, payee_name: 'Padaria', category: ids.food },
        { date: '2026-11-02', amount: 20000, payee_name: 'João', category: null },
        { date: '2026-11-03', amount: -10000, payee: transfer.id },
      ], { runTransfers: true });
      await api.addTransactions(ids.savings, [{ date: '2026-10-06', amount: -999, payee_name: "McDonald's", category: ids.food }]);
    });
  });
  const payees = await api.getPayees();
  ids.mcdonalds = payees.find((payee) => payee.name === "McDonald's").id;
  ids.mercado = payees.find((payee) => payee.name === 'Mercado').id;
  ids.padaria = payees.find((payee) => payee.name === 'Padaria').id;
});

test.after(async () => {
  await quietly(() => api.shutdown());
});
// The API may still flush its metadata right after shutdown: remove the directory only at exit.
process.once('exit', () => rmSync(dataDir, { recursive: true, force: true }));

const spec = (fields) => ({ accountId: ids.checking, from: null, to: '2026-11-19', type: 'expense', minCents: null, maxCents: null, payeeIds: null, categoryId: null, result: 'list', order: 'newest', limit: 5, ...fields });

test('a split purchase counts once: whole purchases without a category filter', async () => {
  const result = await executeSearch(api, spec({ payeeIds: [ids.mercado], result: 'count' }));
  assert.equal(result.count, 1);
  assert.equal(result.total, -30000);
});

test('with a category filter, only the split parts of that category count', async () => {
  const food = await executeSearch(api, spec({ categoryId: ids.food, result: 'sum', from: '2026-10-01', to: '2026-10-31' }));
  // 50 (McDonald's) + 150 (Mercado, food part) + 20 (Padaria)
  assert.deepEqual([food.count, food.total], [3, -22000]);
  const free = await executeSearch(api, spec({ categoryId: ids.free, result: 'sum' }));
  assert.deepEqual([free.count, free.total], [1, -15000]);
});

test('transfers and the starting balance are excluded; the account is always the chat account', async () => {
  const all = await executeSearch(api, spec({ type: 'any', result: 'sum' }));
  // −40 −50 −300 −20 −10 +200 (no starting balance +1000, no transfer −100, no other account −9.99)
  assert.deepEqual([all.count, all.total], [6, -22000]);
  const income = await executeSearch(api, spec({ type: 'income', result: 'list' }));
  assert.deepEqual(income.rows.map((row) => row.amount), [20000]);
});

test('date ranges apply both bounds (one operator per condition)', async () => {
  const october = await executeSearch(api, spec({ from: '2026-10-01', to: '2026-10-31', result: 'count' }));
  assert.equal(october.count, 3);
  assert.deepEqual(buildFilter(spec({ from: '2026-10-01', to: '2026-10-31' })).date, [{ $gte: '2026-10-01' }, { $lte: '2026-10-31' }]);
});

test('amount ranges, newest-first lists, and largest by absolute value', async () => {
  const mid = await executeSearch(api, spec({ minCents: 1500, maxCents: 5000, result: 'list' }));
  assert.deepEqual(mid.rows.map((row) => row.amount), [-2000, -5000, -4000]);
  const last = await executeSearch(api, spec({ payeeIds: [ids.mcdonalds], limit: 1 }));
  assert.deepEqual(last.rows.map((row) => [row.date, row.amount]), [['2026-10-05', -5000]]);
  const largest = await executeSearch(api, spec({ type: 'any', result: 'max' }));
  assert.equal(largest.rows[0].amount, -30000);
  assert.equal(largest.rows[0].is_parent, true);
  const smallest = await executeSearch(api, spec({ result: 'min' }));
  assert.equal(smallest.rows[0].amount, -1000);
});

test('payee matching ignores case, accents and punctuation, and never matches transfer payees', async () => {
  const payees = await api.getPayees();
  assert.deepEqual(matchPayees(payees, 'mc donalds').map((payee) => payee.name), ["McDonald's"]);
  assert.deepEqual(matchPayees(payees, 'joao').map((payee) => payee.name), ['João']);
  assert.deepEqual(matchPayees(payees, 'padria').map((payee) => payee.name), ['Padaria']);
  assert.deepEqual(matchPayees(payees, 'Poupança'), []);
  const empty = await executeSearch(api, spec({ payeeIds: [ids.padaria], from: '2026-12-01', to: '2026-12-31', result: 'sum' }));
  assert.deepEqual([empty.count, empty.total], [0, 0]);
});
