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
