import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCategorySpending } from '../src/category-queries.js';

test('allows spending when the remaining amount is zero or positive', () => {
  assert.deepEqual(evaluateCategorySpending(10000, 10000), { available: 10000, requested: 10000, remaining: 0, canSpend: true });
  assert.equal(evaluateCategorySpending(10000, 5000).canSpend, true);
});

test('rejects spending when it exceeds the available amount', () => {
  assert.deepEqual(evaluateCategorySpending(3000, 5000), { available: 3000, requested: 5000, remaining: -2000, canSpend: false });
});
