import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/parser.js';
import { validateCommand } from '../src/validation.js';

const accounts = [{ id: 'account-1', name: 'Bradesco' }, { id: 'account-2', name: 'Inter' }];
const categories = [
  { id: 'category-food', name: 'Alimentação' },
  { id: 'category-salary', name: 'Salário mensal' },
];

test('validates the selected account by id and the category by canonical name', () => {
  const command = parseCommand("Gastei 40 reais no MCDonald's categoria alimentação");
  assert.deepEqual(validateCommand(command, { accounts, categories, accountId: 'account-1' }), {
    valid: true,
    command: { type: 'expense', amount: 40, description: "MCDonald's", category: 'Alimentação' },
    account: { id: 'account-1', name: 'Bradesco' },
    category: { id: 'category-food', name: 'Alimentação' },
  });
});

test('renaming an account in Actual does not break validation (regression: Bradesco → Nubank)', () => {
  const command = parseCommand('gastei 10 mercado categoria alimentação');
  const renamed = [{ id: 'account-1', name: 'Nubank' }, { id: 'account-2', name: 'Inter' }];
  assert.deepEqual(validateCommand(command, { accounts: renamed, categories, accountId: 'account-1' }).account, { id: 'account-1', name: 'Nubank' });
});

test('matches multi-word categories case-insensitively', () => {
  const command = parseCommand('ganhei 250 freelance categoria SALÁRIO MENSAL');
  assert.equal(validateCommand(command, { accounts, categories, accountId: 'account-2' }).category.id, 'category-salary');
});

test('rejects a category that does not exist', () => {
  const command = parseCommand('gastei 10 mercado categoria transporte');
  assert.throws(() => validateCommand(command, { accounts, categories, accountId: 'account-1' }), /A categoria 'Transporte' não existe/);
});

test('rejects an unknown account id without selecting another account', () => {
  const command = parseCommand('gastei 10 mercado categoria alimentação');
  assert.throws(() => validateCommand(command, { accounts, categories, accountId: 'gone' }), { code: 'ACCOUNT_UNAVAILABLE', reason: 'missing' });
  assert.throws(() => validateCommand(command, { accounts, categories }), { code: 'ACCOUNT_UNAVAILABLE' });
});

test('never selects an account by its name', () => {
  const command = parseCommand('gastei 10 mercado categoria alimentação');
  assert.throws(() => validateCommand(command, { accounts, categories, accountId: 'Bradesco' }), { code: 'ACCOUNT_UNAVAILABLE' });
});

test('validation is pure and does not create transactions', () => {
  const command = parseCommand('ganhei 250 freelance categoria salário mensal');
  const result = validateCommand(command, { accounts, categories, accountId: 'account-1' });
  assert.equal(result.transaction, undefined);
});
