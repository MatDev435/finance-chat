import test from 'node:test';
import assert from 'node:assert/strict';
import { findCategoryAvailability, getSynchronizedCategoryAvailability } from '../src/budget-availability.js';

const categories = [{ id: 'food-id', name: 'Alimentação' }, { id: 'transport-id', name: 'Transporte' }];

test('returns the category balance, not budgeted or spent values', () => {
  const result = findCategoryAvailability(categories, {
    categoryGroups: [{ categories: [{ id: 'food-id', budgeted: 10000, spent: -2500, balance: 7500 }] }],
  }, 'alimentação');
  assert.deepEqual(result, { category: { id: 'food-id', name: 'Alimentação' }, available: 7500 });
});

test('returns zero when the category has no entry in the requested month', () => {
  assert.equal(findCategoryAvailability(categories, { categoryGroups: [] }, 'Transporte').available, 0);
});

test('rejects an unknown category', () => {
  assert.throws(() => findCategoryAvailability(categories, { categoryGroups: [] }, 'Lazer'), /A categoria 'Lazer' não existe/);
});

test('synchronizes before reading categories and the budget month', async () => {
  const calls = [];
  const api = {
    async sync() { calls.push('sync'); },
    async getCategories() { calls.push('categories'); return categories; },
    async getBudgetMonth() {
      calls.push('month');
      return { categoryGroups: [{ categories: [{ id: 'food-id', balance: 6700 }] }] };
    },
  };

  const result = await getSynchronizedCategoryAvailability(api, 'alimentação', '2026-09');

  assert.equal(result.available, 6700);
  assert.equal(calls[0], 'sync');
  assert.deepEqual(calls.slice(1).sort(), ['categories', 'month']);
});
