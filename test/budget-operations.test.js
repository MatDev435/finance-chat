import test from 'node:test';
import assert from 'node:assert/strict';
import { commitTransaction, listChatAccounts, prepareTransaction, undoTransaction } from '../src/budget-operations.js';
import { parseCommand } from '../src/parser.js';
import { createBudget, createFakeActual } from './support/fake-actual.js';

async function openWorld(accounts) {
  const budget = createBudget({
    accounts,
    categories: [{ id: 'cat-food', name: 'Alimentação' }, { id: 'cat-transport', name: 'Transporte' }],
  });
  const api = createFakeActual({ 'https://a.example': { password: 'p', files: { s: budget } } });
  await api.init({ serverURL: 'https://a.example', password: 'p' });
  await api.downloadBudget('s');
  return { api, budget };
}

const ACCOUNTS = () => [
  { id: 'acc-nubank', name: 'Nubank', closed: false, offbudget: false },
  { id: 'acc-inter', name: 'Inter', closed: false, offbudget: false },
  { id: 'acc-old', name: 'Bradesco antigo', closed: true, offbudget: false },
  { id: 'acc-invest', name: 'Investimentos', closed: false, offbudget: true },
];

const command = () => parseCommand('Gastei 40 reais no mercado categoria alimentação');

test('lists only open on-budget accounts, by id, after syncing', async () => {
  const { api } = await openWorld(ACCOUNTS());
  assert.deepEqual(await listChatAccounts(api), [{ id: 'acc-nubank', name: 'Nubank' }, { id: 'acc-inter', name: 'Inter' }]);
  assert.equal(api.calls.at(-1).op, 'sync');
});

test('a renamed account keeps its chat: same id, new display name', async () => {
  const { api, budget } = await openWorld(ACCOUNTS());
  budget.accounts[0].name = 'Nubank Roxinho';
  assert.deepEqual((await listChatAccounts(api))[0], { id: 'acc-nubank', name: 'Nubank Roxinho' });
  const { validation, mapped } = await prepareTransaction(api, { accountId: 'acc-nubank', command: command(), date: '2026-11-16' });
  assert.deepEqual(validation.account, { id: 'acc-nubank', name: 'Nubank Roxinho' });
  assert.equal(mapped.accountId, 'acc-nubank');
});

test('new accounts appear and deleted accounts disappear on the next listing', async () => {
  const { api, budget } = await openWorld(ACCOUNTS());
  budget.accounts.push({ id: 'acc-wallet', name: 'Carteira' });
  budget.accounts.splice(1, 1);
  assert.deepEqual((await listChatAccounts(api)).map((account) => account.id), ['acc-nubank', 'acc-wallet']);
});

test('the transaction goes to the selected account, not to another one', async () => {
  const { api, budget } = await openWorld(ACCOUNTS());
  const { mapped } = await prepareTransaction(api, { accountId: 'acc-inter', command: command(), date: '2026-11-16' });
  const result = await commitTransaction(api, mapped);
  assert.equal(budget.transactions.length, 1);
  const { id, ...stored } = budget.transactions[0];
  assert.deepEqual(result, { account: { id: 'acc-inter', name: 'Inter' }, synced: true, transactionId: id });
  assert.deepEqual(stored, { date: '2026-11-16', amount: -4000, payee_name: 'mercado', category: 'cat-food', account: 'acc-inter' });
});

test('preview refuses unknown, closed and off-budget accounts without any fallback', async () => {
  const { api, budget } = await openWorld(ACCOUNTS());
  for (const [accountId, reason] of [['acc-missing', 'missing'], ['acc-old', 'closed'], ['acc-invest', 'offbudget'], [undefined, 'missing']]) {
    await assert.rejects(() => prepareTransaction(api, { accountId, command: command(), date: '2026-11-16' }), { code: 'ACCOUNT_UNAVAILABLE', reason });
  }
  assert.equal(budget.transactions.length, 0);
});

test('commit re-validates: an account deleted after the preview receives nothing', async () => {
  const { api, budget } = await openWorld(ACCOUNTS());
  const { mapped } = await prepareTransaction(api, { accountId: 'acc-inter', command: command(), date: '2026-11-16' });
  budget.accounts = budget.accounts.filter((account) => account.id !== 'acc-inter');
  await assert.rejects(() => commitTransaction(api, mapped), { code: 'ACCOUNT_UNAVAILABLE' });
  assert.equal(budget.transactions.length, 0);
});

test('commit re-validates: an account closed after the preview receives nothing', async () => {
  const { api, budget } = await openWorld(ACCOUNTS());
  const { mapped } = await prepareTransaction(api, { accountId: 'acc-nubank', command: command(), date: '2026-11-16' });
  budget.accounts[0].closed = true;
  await assert.rejects(() => commitTransaction(api, mapped), { code: 'ACCOUNT_UNAVAILABLE', reason: 'closed' });
  assert.equal(budget.transactions.length, 0);
});

test('commit refuses a category deleted after the preview', async () => {
  const { api, budget } = await openWorld(ACCOUNTS());
  const { mapped } = await prepareTransaction(api, { accountId: 'acc-nubank', command: command(), date: '2026-11-16' });
  budget.categories = budget.categories.filter((category) => category.id !== 'cat-food');
  await assert.rejects(() => commitTransaction(api, mapped), { code: 'VALIDATION_ERROR' });
  assert.equal(budget.transactions.length, 0);
});

test('if syncing before the write fails, nothing is written', async () => {
  const { api, budget } = await openWorld(ACCOUNTS());
  const { mapped } = await prepareTransaction(api, { accountId: 'acc-nubank', command: command(), date: '2026-11-16' });
  api.hooks.beforeSync = () => { throw Object.assign(new Error('offline'), { code: 'network-failure' }); };
  await assert.rejects(() => commitTransaction(api, mapped), { code: 'network-failure' });
  assert.equal(budget.transactions.length, 0);
});

test('a failed sync after a successful write is reported, not hidden and not retried', async () => {
  const { api, budget } = await openWorld(ACCOUNTS());
  const { mapped } = await prepareTransaction(api, { accountId: 'acc-nubank', command: command(), date: '2026-11-16' });
  api.hooks.beforeAdd = () => { api.hooks.beforeSync = () => { throw Object.assign(new Error('offline'), { code: 'network-failure' }); }; };
  const result = await commitTransaction(api, mapped);
  assert.equal(result.synced, false);
  assert.equal(budget.transactions.length, 1);
  assert.equal(api.calls.filter((call) => call.op === 'add').length, 1);
});

test('a failing write is reported as uncertain', async () => {
  const { api } = await openWorld(ACCOUNTS());
  const { mapped } = await prepareTransaction(api, { accountId: 'acc-nubank', command: command(), date: '2026-11-16' });
  api.hooks.beforeAdd = () => { throw new Error('disk full'); };
  await assert.rejects(() => commitTransaction(api, mapped), { code: 'WRITE_UNCERTAIN', message: /Verifique no Actual/ });
});

test('a split purchase is written once with its parts; a part whose category vanished blocks the write', async () => {
  const { api, budget } = await openWorld(ACCOUNTS());
  const split = parseCommand('Gastei 100 no mercado categorias 70 alimentação, 30 transporte');
  const { mapped } = await prepareTransaction(api, { accountId: 'acc-inter', command: split, date: '2026-11-18' });
  await commitTransaction(api, mapped);
  assert.equal(budget.transactions.length, 1);
  assert.deepEqual(budget.transactions[0].subtransactions, [{ amount: -7000, category: 'cat-food' }, { amount: -3000, category: 'cat-transport' }]);

  const again = await prepareTransaction(api, { accountId: 'acc-inter', command: split, date: '2026-11-18' });
  budget.categories = budget.categories.filter((category) => category.id !== 'cat-transport');
  await assert.rejects(() => commitTransaction(api, again.mapped), { code: 'VALIDATION_ERROR' });
  assert.equal(budget.transactions.length, 1);
});

test('commit identifies the created transaction even with others on the same day', async () => {
  const { api, budget } = await openWorld(ACCOUNTS());
  budget.transactions.push({ id: 'existing', account: 'acc-nubank', date: '2026-11-18', amount: -100 });
  const { mapped } = await prepareTransaction(api, { accountId: 'acc-nubank', command: command(), date: '2026-11-18' });
  const result = await commitTransaction(api, mapped);
  assert.notEqual(result.transactionId, 'existing');
  assert.equal(budget.transactions.find((t) => t.id === result.transactionId).amount, -4000);
});

test('undo deletes only the transaction it created, if unchanged', async () => {
  const { api, budget } = await openWorld(ACCOUNTS());
  budget.transactions.push({ id: 'other', account: 'acc-nubank', date: '2026-11-18', amount: -4000 });
  const { mapped } = await prepareTransaction(api, { accountId: 'acc-nubank', command: command(), date: '2026-11-18' });
  const { transactionId } = await commitTransaction(api, mapped);
  const entry = { accountId: 'acc-nubank', transactionId, date: '2026-11-18', amount: -4000 };
  assert.deepEqual(await undoTransaction(api, entry), { synced: true });
  assert.deepEqual(budget.transactions.map((t) => t.id), ['other'], 'the identical-looking transaction is untouched');
  await assert.rejects(() => undoTransaction(api, entry), { code: 'UNDO_NOT_FOUND' });
});

test('undo refuses a transaction changed in Actual, or moved to another date or account', async () => {
  const { api, budget } = await openWorld(ACCOUNTS());
  const { mapped } = await prepareTransaction(api, { accountId: 'acc-nubank', command: command(), date: '2026-11-18' });
  const { transactionId } = await commitTransaction(api, mapped);
  const entry = { accountId: 'acc-nubank', transactionId, date: '2026-11-18', amount: -4000 };
  budget.transactions[0].amount = -4500;
  await assert.rejects(() => undoTransaction(api, entry), { code: 'UNDO_CHANGED' });
  budget.transactions[0].amount = -4000;
  budget.transactions[0].date = '2026-11-17';
  await assert.rejects(() => undoTransaction(api, entry), { code: 'UNDO_NOT_FOUND' });
  budget.transactions[0].date = '2026-11-18';
  budget.transactions[0].account = 'acc-inter';
  await assert.rejects(() => undoTransaction(api, entry), { code: 'UNDO_NOT_FOUND' });
  assert.equal(budget.transactions.length, 1, 'nothing was deleted');
});

test('undo: sync failure before deleting changes nothing; a failing delete is uncertain', async () => {
  const { api, budget } = await openWorld(ACCOUNTS());
  const { mapped } = await prepareTransaction(api, { accountId: 'acc-nubank', command: command(), date: '2026-11-18' });
  const { transactionId } = await commitTransaction(api, mapped);
  const entry = { accountId: 'acc-nubank', transactionId, date: '2026-11-18', amount: -4000 };
  api.hooks.beforeSync = () => { throw Object.assign(new Error('offline'), { code: 'network-failure' }); };
  await assert.rejects(() => undoTransaction(api, entry), { code: 'network-failure' });
  assert.equal(budget.transactions.length, 1);
  api.hooks.beforeSync = null;
  api.hooks.beforeDelete = () => { throw new Error('disk'); };
  await assert.rejects(() => undoTransaction(api, entry), { code: 'UNDO_UNCERTAIN' });
});

test('undo of a split purchase removes the whole transaction', async () => {
  const { api, budget } = await openWorld(ACCOUNTS());
  const split = parseCommand('Gastei 100 no mercado categorias 70 alimentação, 30 transporte');
  const { mapped } = await prepareTransaction(api, { accountId: 'acc-inter', command: split, date: '2026-11-18' });
  const { transactionId } = await commitTransaction(api, mapped);
  await undoTransaction(api, { accountId: 'acc-inter', transactionId, date: '2026-11-18', amount: -10000 });
  assert.equal(budget.transactions.length, 0);
});
