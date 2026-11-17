import test from 'node:test';
import assert from 'node:assert/strict';
import { entrySummary, initials, reconcileSelection, resolveInitialAccount, viewFor } from '../public/js/navigation.js';

const accounts = [{ id: 'acc-nubank', name: 'Nubank' }, { id: 'acc-inter', name: 'Inter' }, { id: 'acc-wallet', name: 'Carteira' }];

test('opens the default account when it exists', () => {
  assert.deepEqual(resolveInitialAccount({ accounts, defaultAccountId: 'acc-nubank' }), { accountId: 'acc-nubank', defaultMissing: false });
});

test('without a default, no chat is opened automatically', () => {
  assert.deepEqual(resolveInitialAccount({ accounts, defaultAccountId: null }), { accountId: null, defaultMissing: false });
});

test('a default that no longer exists is reported, never replaced by another account', () => {
  assert.deepEqual(resolveInitialAccount({ accounts, defaultAccountId: 'acc-deleted' }), { accountId: null, defaultMissing: true });
});

test('a renamed default still opens (matched by id)', () => {
  const renamed = [{ id: 'acc-nubank', name: 'Nubank PF' }];
  assert.equal(resolveInitialAccount({ accounts: renamed, defaultAccountId: 'acc-nubank' }).accountId, 'acc-nubank');
});

test('keeps the selected chat after a refresh only if the account still exists', () => {
  assert.equal(reconcileSelection(accounts, 'acc-inter'), 'acc-inter');
  assert.equal(reconcileSelection([{ id: 'acc-inter', name: 'Inter PJ' }], 'acc-inter'), 'acc-inter');
  assert.equal(reconcileSelection(accounts, 'acc-gone'), null);
  assert.equal(reconcileSelection(accounts, null), null);
});

test('mobile shows one pane at a time; desktop always shows the list', () => {
  assert.equal(viewFor({ mobile: true, selectedId: null }), 'list');
  assert.equal(viewFor({ mobile: true, selectedId: 'acc-nubank' }), 'chat');
  assert.equal(viewFor({ mobile: true, selectedId: 'acc-nubank', settingsOpen: true }), 'settings');
  assert.equal(viewFor({ mobile: false, selectedId: null }), 'empty');
  assert.equal(viewFor({ mobile: false, selectedId: 'acc-inter' }), 'chat');
});

test('builds avatar initials and list summaries', () => {
  assert.equal(initials('Nubank'), 'NU');
  assert.equal(initials('Banco Inter'), 'BI');
  assert.equal(initials('  '), '?');
  assert.equal(entrySummary({ role: 'user', kind: 'text', text: 'Gastei 40 no mercado\nlinha 2' }), 'Você: Gastei 40 no mercado');
  assert.match(entrySummary({ role: 'assistant', kind: 'preview', status: 'confirmed', data: { type: 'expense', amount: 40 } }), /^Despesa de R\$\s?40,00 registrada$/);
  assert.equal(entrySummary(null), '');
});
