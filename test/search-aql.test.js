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
import { buildFilter, executeSearch, matchPayees, notesPattern } from '../src/search.js';
import { accountTotals, budgetOverview } from '../src/summary.js';

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
        { date: '2026-10-20', amount: -30000, payee_name: 'Mercado', notes: 'Compra no Pão de Açúcar, 50% de desconto', subtransactions: [{ amount: -15000, category: ids.food }, { amount: -15000, category: ids.free }] },
        { date: '2026-10-31', amount: -2000, payee_name: 'Padaria', category: ids.food, notes: 'Pão de queijo' },
        { date: '2026-11-01', amount: -1000, payee_name: 'Padaria', category: ids.food, notes: 'PAO francês' },
        { date: '2026-11-02', amount: 20000, payee_name: 'João', category: null },
        { date: '2026-11-03', amount: -10000, payee: transfer.id },
      ], { runTransfers: true });
      await api.addTransactions(ids.savings, [{ date: '2026-10-06', amount: -999, payee_name: "McDonald's", category: ids.food }]);
      await api.setBudgetAmount('2026-10', ids.food, 20000);
      await api.setBudgetAmount('2026-10', ids.free, 30000);
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

test('notes: a case- and accent-insensitive "contains", with the purchase note counting for its split parts', async () => {
  assert.equal(notesPattern('  Pão  de AÇÚCAR '), '%pao de acucar%');
  const pao = await executeSearch(api, spec({ notesPattern: notesPattern('pão'), result: 'list' }));
  // Both Padaria notes ("Pão de queijo", "PAO francês") and the Mercado purchase ("Pão de Açúcar"), counted once.
  assert.deepEqual(pao.rows.map((row) => row.amount), [-1000, -2000, -30000]);
  const queijo = await executeSearch(api, spec({ notesPattern: notesPattern('QUEIJO'), result: 'sum' }));
  assert.deepEqual([queijo.count, queijo.total], [1, -2000]);
  // Category search over split parts: the food part matches through the parent's note, the other part does not.
  const foodPart = await executeSearch(api, spec({ categoryId: ids.food, notesPattern: notesPattern('pao de acucar'), result: 'sum' }));
  assert.deepEqual([foodPart.count, foodPart.total], [1, -15000]);
});

test('notes: wildcards typed by the user are literal characters', async () => {
  assert.equal(notesPattern('50%'), '%50\\%%');
  const percent = await executeSearch(api, spec({ notesPattern: notesPattern('50%'), result: 'count' }));
  assert.equal(percent.count, 1);
  // Unescaped, "?" would match any single character (and "%" anything).
  const question = await executeSearch(api, spec({ notesPattern: notesPattern('?'), result: 'count' }));
  assert.equal(question.count, 0);
  const anything = await executeSearch(api, spec({ notesPattern: notesPattern('%'), result: 'count' }));
  assert.equal(anything.count, 1);
  // With an "any" amount range ($or) the notes condition is combined with $and.
  const filter = buildFilter(spec({ type: 'any', minCents: 100, notesPattern: '%pao%' }));
  assert.ok(filter.$and && !filter.$or);
  const combined = await executeSearch(api, spec({ type: 'any', minCents: 100, notesPattern: notesPattern('pao'), result: 'count' }));
  assert.equal(combined.count, 3);
});

test('month summary on the real engine: account totals via AQL and the budget month (all accounts)', async () => {
  const totals = await accountTotals(api, { accountId: ids.checking, from: '2026-10-01', to: '2026-10-31' });
  // McDonald's 50, Mercado 300 (split, once), Padaria 20; the other account and transfers are not counted.
  assert.deepEqual([totals.expenses, totals.expenseCount, totals.incomes, totals.incomeCount], [37000, 3, 0, 0]);
  assert.deepEqual(totals.top.map((row) => row.amount), [-30000, -5000, -2000]);
  assert.equal(totals.top[0].is_parent, true);
  const november = await accountTotals(api, { accountId: ids.checking, from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual([november.expenses, november.incomes, november.incomeCount], [1000, 20000, 1]);

  const budget = budgetOverview(await api.getBudgetMonth('2026-10'));
  // Food (all accounts): 50 + 150 + 20 + 9,99 = 229,99 of 200 budgeted; Livre: 150 of 300.
  assert.deepEqual([budget.budgeted, budget.spent], [50000, 37999]);
  assert.deepEqual(budget.topCategories, [{ name: 'Alimentação', spent: 22999 }, { name: 'Livre', spent: 15000 }]);
  assert.deepEqual(budget.overspent, [{ name: 'Alimentação', balance: -2999 }]);
});
