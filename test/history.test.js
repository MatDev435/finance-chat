import test from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY_LIMIT, createHistory, historyKey, sanitizeEntry } from '../public/js/history.js';

function memoryStorage() {
  const data = new Map();
  return {
    data,
    get length() { return data.size; },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

const message = (index, extra = {}) => ({ id: `m${index}`, role: 'user', kind: 'text', text: `mensagem ${index}`, at: index, ...extra });

test('keeps at most 10 messages per chat, dropping the oldest', () => {
  const storage = memoryStorage();
  const history = createHistory(storage, 1);
  for (let index = 1; index <= 13; index += 1) history.append('acc-nubank', message(index));
  const entries = history.load('acc-nubank');
  assert.equal(HISTORY_LIMIT, 10);
  assert.equal(entries.length, 10);
  assert.deepEqual(entries.map((entry) => entry.text), Array.from({ length: 10 }, (_, i) => `mensagem ${i + 4}`));
  assert.equal(JSON.parse(storage.getItem(historyKey(1, 'acc-nubank'))).length, 10);
});

test('each chat has its own history, keyed by the stable account id', () => {
  const history = createHistory(memoryStorage(), 1);
  history.append('acc-nubank', message(1));
  history.append('acc-inter', message(2));
  assert.deepEqual(history.load('acc-nubank').map((e) => e.id), ['m1']);
  assert.deepEqual(history.load('acc-inter').map((e) => e.id), ['m2']);
  assert.deepEqual(history.load('acc-unknown'), []);
});

test('history survives a reload (new instance, same storage)', () => {
  const storage = memoryStorage();
  createHistory(storage, 1).append('acc-nubank', message(1));
  assert.equal(createHistory(storage, 1).load('acc-nubank')[0].text, 'mensagem 1');
});

test('another user in the same browser never sees the previous user\'s history', () => {
  const storage = memoryStorage();
  const ana = createHistory(storage, 1);
  ana.append('acc-shared-id', message(1));
  const bia = createHistory(storage, 2);
  assert.deepEqual(bia.load('acc-shared-id'), []);
  bia.append('acc-shared-id', message(2));
  assert.deepEqual(ana.load('acc-shared-id').map((e) => e.id), ['m1']);
});

test('clear() removes only the current user\'s chats', () => {
  const storage = memoryStorage();
  const ana = createHistory(storage, 1);
  const user11 = createHistory(storage, 11);
  ana.append('a', message(1));
  ana.append('b', message(2));
  user11.append('a', message(3));
  storage.setItem('unrelated', 'keep');
  ana.clear();
  assert.deepEqual(ana.load('a'), []);
  assert.deepEqual(ana.load('b'), []);
  assert.equal(user11.load('a').length, 1, 'user 11 is not matched by the prefix of user 1');
  assert.equal(storage.getItem('unrelated'), 'keep');
});

test('updates an entry status in place (e.g. preview confirmed)', () => {
  const history = createHistory(memoryStorage(), 1);
  history.append('acc', { id: 'p1', role: 'assistant', kind: 'preview', text: 'Entendi!', status: 'pending', data: { type: 'expense', amount: 40, description: 'Mercado', category: 'Alimentação', account: 'Nubank', date: '2026-11-16' } });
  history.update('acc', 'p1', { status: 'confirmed' });
  assert.equal(history.load('acc')[0].status, 'confirmed');
  assert.equal(history.last('acc').id, 'p1');
});

test('stores only whitelisted display fields, never ids or credentials', () => {
  const clean = sanitizeEntry({
    id: 'p1', role: 'assistant', kind: 'preview', text: 'ok', status: 'pending', pendingId: 'secret-pending', token: 'abc',
    data: { type: 'expense', amount: 10, description: 'x', category: 'y', account: 'Nubank', date: '2026-11-16', accountId: 'acc', password: 'p' },
  });
  assert.equal('pendingId' in clean, false);
  assert.equal('token' in clean, false);
  assert.equal('accountId' in clean.data, false);
  assert.equal('password' in clean.data, false);
  assert.equal(sanitizeEntry({ role: 'system', kind: 'text' }), null);
  assert.equal(sanitizeEntry({ role: 'user', kind: 'html' }), null);
  assert.equal(sanitizeEntry({ role: 'user', kind: 'text', text: 'x'.repeat(5000) }).text.length, 2000);
});

test('corrupted or blocked storage does not break the chat', () => {
  const storage = memoryStorage();
  storage.setItem(historyKey(1, 'acc'), '{not json');
  const history = createHistory(storage, 1);
  assert.deepEqual(history.load('acc'), []);
  const blocked = { ...memoryStorage(), getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
  const fragile = createHistory(blocked, 1);
  assert.doesNotThrow(() => fragile.append('acc', message(1)));
  assert.deepEqual(fragile.load('acc'), []);
});

test('works in memory when storage is unavailable', () => {
  const history = createHistory(null, 1);
  history.append('acc', message(1));
  assert.equal(history.load('acc').length, 1);
  history.clear();
  assert.equal(history.load('acc').length, 0);
});

test('stores the parts of a split preview (category name and value only)', () => {
  const clean = sanitizeEntry({
    id: 'p', role: 'assistant', kind: 'preview', text: 'ok', status: 'pending',
    data: { type: 'expense', amount: 100, description: 'mercado', category: '', account: 'Nubank', date: '2026-11-18', parts: [{ category: 'Alimentação', amount: 70, id: 'secret' }, { category: 'Limpeza', amount: 30 }] },
  });
  assert.deepEqual(clean.data.parts, [{ category: 'Alimentação', amount: 70 }, { category: 'Limpeza', amount: 30 }]);
});

test('AI entries keep display fields only: batches, clarifications and searches', () => {
  const batch = sanitizeEntry({
    id: 'b1', role: 'assistant', kind: 'batch', text: 'Confira', at: 1, status: 'partial', ai: true, pendingId: 'secret-pending',
    data: { items: [{ type: 'expense', amount: 45, description: 'Farmácia', category: 'Saúde', date: '2026-11-18', categoryId: 'cat-health' }], expenses: 45, incomes: 0, account: 'Nubank', accountId: 'acc-1' },
  });
  assert.deepEqual(batch, {
    id: 'b1', role: 'assistant', kind: 'batch', text: 'Confira', at: 1, status: 'partial', ai: true,
    data: { items: [{ type: 'expense', amount: 45, description: 'Farmácia', category: 'Saúde', date: '2026-11-18' }], expenses: 45, incomes: 0, account: 'Nubank' },
  });

  const clarify = sanitizeEntry({
    id: 'c1', role: 'assistant', kind: 'clarify', text: 'Falta a categoria', at: 1, status: 'pending', draftId: 'd-1',
    data: { items: [{ type: 'expense', amount: null, description: 'Uber', category: null }], missing: [{ label: 'Valor de Uber', suggestions: [{ id: 'cat-x', name: 'X' }] }], categories: [{ id: 'cat-x', name: 'X' }] },
  });
  assert.deepEqual(clarify.data, { items: [{ type: 'expense', amount: null, description: 'Uber', category: '', date: '' }], missing: [{ label: 'Valor de Uber' }] });
  assert.equal(JSON.stringify(clarify).includes('cat-x'), false);
  assert.equal(JSON.stringify(clarify).includes('d-1'), false);

  const search = sanitizeEntry({
    id: 's1', role: 'assistant', kind: 'search', text: 'Encontrei 1', at: 1,
    data: { result: 'list', type: 'expense', from: null, to: '2026-11-19', account: 'Nubank', payees: ["McDonald's"], category: null, count: 1, total: -3800, transactions: [{ date: '2026-11-16', amount: -3800, payee: "McDonald's", category: 'Alimentação', id: 't-1' }] },
  });
  assert.deepEqual(search.data.transactions, [{ date: '2026-11-16', amount: -3800, payee: "McDonald's", category: 'Alimentação' }]);
  assert.equal(sanitizeEntry({ id: 'x', role: 'assistant', kind: 'search', text: '', at: 1, ai: 'yes' }).ai, undefined);
});

test('month summaries and search notes keep display fields only', () => {
  const summary = sanitizeEntry({
    id: 'r1', role: 'assistant', kind: 'summary', text: 'Resumo de novembro de 2026', at: 1, accountId: 'acc-1',
    data: {
      month: '2026-11', from: '2026-11-01', to: '2026-11-20', account: 'Nubank', accountId: 'acc-1',
      expenses: 36500, expenseCount: 4, incomes: 500000, incomeCount: 1, net: 463500,
      topExpenses: [{ date: '2026-11-01', amount: -30000, payee: 'Mercado', category: 'Dividida em categorias', notes: 'compra do mês', id: 't1' }],
      budget: { budgeted: 50000, spent: 44277, topCategories: [{ name: 'Alimentação', spent: 29777, id: 'cat-food' }], overspent: [{ name: 'Alimentação', balance: -4777 }], overspentCount: 1 },
    },
  });
  assert.deepEqual(summary.data.topExpenses, [{ date: '2026-11-01', amount: -30000, payee: 'Mercado', category: 'Dividida em categorias' }]);
  assert.deepEqual(summary.data.budget.topCategories, [{ name: 'Alimentação', spent: 29777 }]);
  assert.equal(JSON.stringify(summary).includes('acc-1'), false);
  assert.equal(JSON.stringify(summary).includes('cat-food'), false);
  assert.equal(sanitizeEntry({ id: 'r2', role: 'assistant', kind: 'summary', text: '', at: 1, data: { month: '2026-10', budget: null } }).data.budget, null);

  const search = sanitizeEntry({
    id: 's2', role: 'assistant', kind: 'search', text: '', at: 1,
    data: { result: 'sum', type: 'expense', to: '2026-11-19', notes: 'Monster', transactions: [{ date: '2026-11-16', amount: -3800, notes: 'Big Mac e Monster' }] },
  });
  assert.equal(search.data.notes, 'Monster');
  assert.equal(search.data.transactions[0].notes, 'Big Mac e Monster');
});

test('month-by-month searches keep their months', () => {
  const entry = sanitizeEntry({ id: 'm1', role: 'assistant', kind: 'search', text: '', at: 1, data: { result: 'by_month', type: 'expense', to: '2026-11-20', months: [{ month: '2026-10', count: 2, total: -12500, extra: 'x' }] } });
  assert.equal(entry.data.result, 'by_month');
  assert.deepEqual(entry.data.months, [{ month: '2026-10', count: 2, total: -12500 }]);
});
