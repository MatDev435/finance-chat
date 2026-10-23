import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/parser.js';
import { validateCommand } from '../src/validation.js';

const accounts = [{ id: 'account-1', name: 'Bradesco' }];
const categories = [
  { id: 'category-food', name: 'Alimentação' },
  { id: 'category-salary', name: 'Salário mensal' },
];

test('validates an existing account and category using canonical names', () => {
  const command = parseCommand("Gastei 40 reais no MCDonald's categoria alimentação");
  assert.deepEqual(validateCommand(command, { accounts, categories }), {
    valid: true,
    command: { type: 'expense', amount: 40, description: "MCDonald's", category: 'Alimentação' },
    account: { id: 'account-1', name: 'Bradesco' },
    category: { id: 'category-food', name: 'Alimentação' },
  });
});

test('matches multi-word categories case-insensitively', () => {
  const command = parseCommand('ganhei 250 freelance categoria SALÁRIO MENSAL');
  assert.equal(validateCommand(command, { accounts, categories }).category.id, 'category-salary');
});

test('rejects a category that does not exist', () => {
  const command = parseCommand('gastei 10 mercado categoria transporte');
  assert.throws(() => validateCommand(command, { accounts, categories }), /A categoria 'Transporte' não existe/);
});

test('rejects when Bradesco does not exist without selecting another account', () => {
  const command = parseCommand('gastei 10 mercado categoria alimentação');
  assert.throws(() => validateCommand(command, { accounts: [{ id: 'other', name: 'Nubank' }], categories }), /A conta 'Bradesco' não existe/);
});

test('validation is pure and does not create transactions', () => {
  const command = parseCommand('ganhei 250 freelance categoria salário mensal');
  const result = validateCommand(command, { accounts, categories });
  assert.equal(result.transaction, undefined);
});
