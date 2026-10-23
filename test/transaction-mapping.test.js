import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/parser.js';
import { validateCommand } from '../src/validation.js';
import { toActualImport } from '../src/transaction-mapping.js';

const accounts = [{ id: 'account-bradesco', name: 'Bradesco' }];
const categories = [
  { id: 'category-food', name: 'Alimentação' },
  { id: 'category-transport', name: 'Transporte' },
  { id: 'category-income', name: 'Salário' },
];

function validated(message) {
  const command = parseCommand(message);
  return validateCommand(command, { accounts, categories });
}

test('maps an expense payee, account, category, and cents without notes', () => {
  const result = toActualImport(validated("Gastei 50 reais no MC Donald's categoria alimentação"), '2026-09-15');

  assert.deepEqual(result, {
    accountId: 'account-bradesco',
    transaction: {
      date: '2026-09-15',
      amount: -5000,
      payee_name: "MC Donald's",
      category: 'category-food',
    },
  });
  assert.equal('notes' in result.transaction, false);
  assert.equal('description' in result.transaction, false);
});

test('maps income as positive integer cents', () => {
  const result = toActualImport(validated('Ganhei 250,50 de freelance categoria salário'), '2026-09-15');

  assert.equal(result.accountId, 'account-bradesco');
  assert.deepEqual(result.transaction, {
    date: '2026-09-15',
    amount: 25050,
    payee_name: 'freelance',
    category: 'category-income',
  });
});

test('maps an optional note to Actual transaction notes', () => {
  const result = toActualImport(validated('Gastei 10,94 no Uber categoria transporte notas indo para tal lugar'), '2026-09-15');

  assert.deepEqual(result, {
    accountId: 'account-bradesco',
    transaction: {
      date: '2026-09-15',
      amount: -1094,
      payee_name: 'Uber',
      category: 'category-transport',
      notes: 'Indo para tal lugar',
    },
  });
});
