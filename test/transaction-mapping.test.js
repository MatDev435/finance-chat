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
  return validateCommand(command, { accounts, categories, accountId: 'account-bradesco' });
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

test('maps a split purchase to subtransactions with signed integer cents and no parent category', () => {
  const splitCategories = [...categories, { id: 'category-cleaning', name: 'Limpeza' }];
  const command = parseCommand('Gastei 100,50 no mercado categorias 70,50 alimentação, 30 limpeza notas compra do mês');
  const result = toActualImport(validateCommand(command, { accounts, categories: splitCategories, accountId: 'account-bradesco' }), '2026-11-18');
  assert.deepEqual(result, {
    accountId: 'account-bradesco',
    transaction: {
      date: '2026-11-18',
      amount: -10050,
      payee_name: 'mercado',
      subtransactions: [{ amount: -7050, category: 'category-food' }, { amount: -3000, category: 'category-cleaning' }],
      notes: 'Compra do mês',
    },
  });
  const income = toActualImport(validateCommand(parseCommand('Recebi 300 da empresa categorias 200 salário, 100 alimentação'), { accounts, categories, accountId: 'account-bradesco' }), '2026-11-18');
  assert.deepEqual(income.transaction.subtransactions.map((part) => part.amount), [20000, 10000]);
});

test('a split with an unknown category fails with suggestions in the text only', () => {
  const command = parseCommand('Gastei 100 no mercado categorias 70 alimentaçao, 30 transprte');
  try {
    validateCommand(command, { accounts, categories, accountId: 'account-bradesco' });
    assert.fail('should throw');
  } catch (error) {
    assert.match(error.message, /Transprte.*Você quis dizer: Transporte\?/);
    assert.equal(error.suggestions, undefined);
  }
});
