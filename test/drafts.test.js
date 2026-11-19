import test from 'node:test';
import assert from 'node:assert/strict';
import { applyUpdates, checkItems, draftContext, draftItemsFrom, missingFields, resolveItems, toCommand } from '../src/drafts.js';
import { createConversationStore } from '../src/conversation.js';
import { createUndoStore } from '../src/undo.js';
import { localDraftUpdate } from '../src/chat.js';

const CATEGORIES = [
  { id: 'c1', name: 'Alimentação' },
  { id: 'c2', name: 'Reembolso Alimentação' },
  { id: 'c3', name: 'Livre' },
  { id: 'c4', name: 'Saúde' },
  { id: 'c5', name: 'Velha', hidden: true },
];
const item = (fields) => ({ type: 'expense', amount: null, description: null, category: null, hints: [], splits: null, notes: null, when: null, ...fields });

test('a typed category is used only when it matches the budget; hints never pick one', () => {
  const [typed, accentless, hinted, unknown] = resolveItems(draftItemsFrom([
    item({ amount: 10, category: 'alimentação' }),
    item({ amount: 10, category: 'saude' }),
    item({ amount: 10, hints: ['Alimentação', 'Reembolso Alimentação', 'Velha'] }),
    item({ amount: 10, category: 'Remédios' }),
  ]), CATEGORIES);
  assert.deepEqual(typed.category, { name: 'Alimentação', id: 'c1', suggestions: [] });
  assert.equal(accentless.category.id, 'c4');
  assert.equal(hinted.category.id, null, 'the model suggestion is not applied');
  assert.deepEqual(hinted.category.suggestions.map((s) => s.name), ['Alimentação', 'Reembolso Alimentação'], 'hidden categories are never suggested');
  assert.deepEqual(unknown.category, { name: 'Remédios', id: null, suggestions: [] });
});

test('lists what is missing, including split parts, in order', () => {
  const items = resolveItems(draftItemsFrom([
    item({ amount: null, description: 'Uber', category: 'livre' }),
    item({ amount: 100, description: 'Mercado', splits: [{ amount: 70, category: 'alimentação' }, { amount: null, category: null }] }),
  ]), CATEGORIES);
  assert.deepEqual(missingFields(items).map(({ item: number, part, field }) => [number, part, field]), [[1, null, 'amount'], [2, 2, 'amount'], [2, 2, 'category']]);
});

test('updates fill only missing fields; a picked id must exist', () => {
  const items = resolveItems(draftItemsFrom([item({ amount: 50, description: 'A', category: 'livre' }), item({ amount: 20, description: 'B' })]), CATEGORIES);
  const { items: next, applied } = applyUpdates(items, [
    { item: 1, part: null, field: 'amount', value: 999 },
    { item: 1, part: null, field: 'category', value: 'Saúde' },
    { item: 2, part: null, field: 'category', value: 'saúde' },
    { item: 9, part: null, field: 'category', value: 'Livre' },
  ], CATEGORIES);
  assert.equal(applied, 1);
  assert.equal(next[0].amount, 50);
  assert.equal(next[0].category.name, 'Livre');
  assert.equal(next[1].category.id, 'c4');
  assert.equal(items[1].category.id, null, 'the input is not mutated');
  assert.throws(() => applyUpdates(items, [{ item: 2, part: null, field: 'category', categoryId: 'gone' }], CATEGORIES), { code: 'VALIDATION_ERROR' });
});

test('split rules: at least two parts, exact total, missing total = sum of the parts', () => {
  assert.throws(() => checkItems([item({ amount: 10, splits: [{ amount: 10, category: { id: 'c1' } }] })]), { code: 'INVALID_COMMAND', message: /duas partes/ });
  assert.throws(() => checkItems([item({ amount: 10, description: 'X', splits: [{ amount: 6 }, { amount: 5 }] }), item({ amount: 1 })]), { message: /^X: A soma das partes/ });
  const [inferred] = checkItems([item({ amount: null, splits: [{ amount: 0.1 }, { amount: 0.2 }] })]);
  assert.equal(inferred.amount, 0.3);
});

test('a complete item becomes a parser-compatible command with resolved ids', () => {
  const [single, split] = resolveItems(draftItemsFrom([
    item({ amount: 5, description: 'Pão', category: 'alimentação', notes: 'Manhã', when: { daysAgo: 1 } }),
    item({ amount: 10, description: 'M', splits: [{ amount: 4, category: 'livre' }, { amount: 6, category: 'saúde' }] }),
  ]), CATEGORIES);
  assert.deepEqual(toCommand(single), { type: 'expense', amount: 5, description: 'Pão', category: 'Alimentação', categoryId: 'c1', notes: 'Manhã', when: { daysAgo: 1 } });
  assert.deepEqual(toCommand(split).splits, [{ amount: 4, category: 'Livre', categoryId: 'c3' }, { amount: 6, category: 'Saúde', categoryId: 'c4' }]);
});

test('the draft sent to the model is compact and has no ids', () => {
  const items = resolveItems(draftItemsFrom([item({ amount: 20, description: 'Farmácia', hints: ['Saúde'] })]), CATEGORIES);
  assert.deepEqual(draftContext(items), [{ item: 1, type: 'expense', amount: '20.00', payee: 'Farmácia', category: null, splits: null, missing: ['category'] }]);
});

test('short replies complete a single missing field locally; anything else goes to the AI', () => {
  const category = [{ item: 1, part: null, field: 'category' }];
  const amount = [{ item: 2, part: 1, field: 'amount' }];
  assert.deepEqual(localDraftUpdate(category, 'Alimentação.'), { item: 1, part: null, field: 'category', value: 'Alimentação' });
  assert.deepEqual(localDraftUpdate(category, 'categoria saúde'), { item: 1, part: null, field: 'category', value: 'saúde' });
  assert.equal(localDraftUpdate(category, 'coloca 20 em saúde'), null);
  assert.deepEqual(localDraftUpdate(amount, 'R$ 30,50'), { item: 2, part: 1, field: 'amount', value: 30.5 });
  assert.equal(localDraftUpdate(amount, 'uns trinta'), null);
  assert.equal(localDraftUpdate([...category, ...amount], 'Saúde'), null, 'two missing fields: ambiguous');
});

test('conversation contexts are per user and account, and expire', () => {
  let time = 0;
  const store = createConversationStore({ now: () => time, ttlMs: 100 });
  const draft = store.putDraft(1, 'a', { items: [1], missing: [], contextKey: 'k' });
  store.putQuery(1, 'a', { payee: 'X' });
  assert.equal(store.getDraft(1, 'a').id, draft.id);
  assert.equal(store.getDraft(2, 'a'), null);
  assert.equal(store.getDraft(1, 'b'), null);
  assert.deepEqual(store.getQuery(1, 'a'), { payee: 'X' });
  assert.notEqual(store.putDraft(1, 'a', { items: [2], contextKey: 'k' }).id, draft.id, 'a new draft gets a new id');
  time = 150;
  assert.equal(store.getDraft(1, 'a'), null);
  assert.equal(store.getQuery(1, 'a'), null);
  assert.equal(store.size, 0);
});

test('undo.discard ends the chat undo window (used after batches)', () => {
  const undo = createUndoStore();
  undo.put(1, 'a', { transactionId: 't1' });
  undo.put(1, 'b', { transactionId: 't2' });
  undo.discard(1, 'a');
  assert.equal(undo.latestId(1, 'a'), null);
  assert.ok(undo.latestId(1, 'b'));
});
