import test from 'node:test';
import assert from 'node:assert/strict';
import { foldName, levenshtein, matchCategory, notFoundMessage, suggestCategories } from '../src/category-match.js';
import { parseCommand } from '../src/parser.js';
import { validateCommand } from '../src/validation.js';

const categories = [
  { id: 'c-food', name: 'Alimentação' },
  { id: 'c-transport', name: 'Transporte' },
  { id: 'c-health', name: 'Saúde' },
  { id: 'c-market', name: 'Supermercado' },
  { id: 'c-bars', name: 'Bares e restaurantes' },
  { id: 'c-hidden', name: 'Alimentos antigos', hidden: true },
];

test('levenshtein distance and accent folding', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('', 'abc'), 3);
  assert.equal(levenshtein('abc', 'abc'), 0);
  assert.equal(foldName('  Alimentação   Fora '), 'alimentacao fora');
});

test('exact names still match first (case-insensitive)', () => {
  assert.equal(matchCategory(categories, 'ALIMENTAÇÃO').category.id, 'c-food');
});

test('a name typed without accents matches when there is a single candidate', () => {
  assert.equal(matchCategory(categories, 'alimentacao').category.id, 'c-food');
  assert.equal(matchCategory(categories, 'saude').category.id, 'c-health');
});

test('two categories differing only by accents are not guessed', () => {
  const twins = [{ id: 'a', name: 'Pão' }, { id: 'b', name: 'Pao' }, { id: 'c', name: 'Pais' }];
  const result = matchCategory(twins, 'PAO');
  assert.equal(result.category.id, 'b', 'exact (case-insensitive) wins');
  const noExact = matchCategory([{ id: 'a', name: 'Pão' }, { id: 'b', name: 'Pâo' }], 'pao');
  assert.equal(noExact.category, null);
  assert.deepEqual(noExact.suggestions.map((item) => item.id), ['a', 'b']);
});

test('typos produce up to 3 ranked suggestions, never hidden categories', () => {
  assert.deepEqual(matchCategory(categories, 'Alimentaçao').category.id, 'c-food', 'missing accent mark only');
  const typo = matchCategory(categories, 'Alimetação');
  assert.equal(typo.category, null);
  assert.deepEqual(typo.suggestions, [{ id: 'c-food', name: 'Alimentação' }]);
  assert.deepEqual(suggestCategories(categories, 'Transprte'), [{ id: 'c-transport', name: 'Transporte' }]);
  assert.deepEqual(suggestCategories(categories, 'mercado').map((item) => item.id), ['c-market'], 'substring');
  assert.deepEqual(suggestCategories(categories, 'bares').map((item) => item.id), ['c-bars'], 'prefix');
  assert.ok(!suggestCategories(categories, 'Alimentos').some((item) => item.id === 'c-hidden'));
  assert.deepEqual(suggestCategories(categories, 'Viagens'), []);
  assert.ok(suggestCategories(categories, 'a').length <= 3);
});

test('the error message lists the suggestions', () => {
  assert.equal(notFoundMessage('Alimetação', [{ id: 'c-food', name: 'Alimentação' }]), "A categoria 'Alimetação' não existe no Actual Budget. Você quis dizer: Alimentação?");
  assert.equal(notFoundMessage('Viagens', []), "A categoria 'Viagens' não existe no Actual Budget.");
});

test('validation returns suggestions and accepts the chosen category id', () => {
  const accounts = [{ id: 'acc', name: 'Nubank' }];
  const command = parseCommand('Gastei 40 no mercado categoria alimetação');
  try {
    validateCommand(command, { accounts, categories, accountId: 'acc' });
    assert.fail('should throw');
  } catch (error) {
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.deepEqual(error.suggestions, [{ id: 'c-food', name: 'Alimentação' }]);
  }
  assert.deepEqual(validateCommand(command, { accounts, categories, accountId: 'acc', categoryId: 'c-food' }).category, { id: 'c-food', name: 'Alimentação' });
  assert.throws(() => validateCommand(command, { accounts, categories, accountId: 'acc', categoryId: 'gone' }), /não existe mais/);
});
