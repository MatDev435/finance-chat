import test from 'node:test';
import assert from 'node:assert/strict';
import { isCompleteParse } from '../src/parse-check.js';
import { checkSplitTotal, parseMessage } from '../src/parser.js';

const check = (message) => isCompleteParse(parseMessage(message));

test('accepts the messages the parser fully understands', () => {
  for (const message of [
    "Gastei 50 reais no McDonald's, categoria alimentação",
    'Ganhei 250,50 de freelance categoria salário',
    'Gastei R$ 10,94 no Uber categoria transporte',
    'Ontem gastei 40 reais no mercado categoria alimentação',
    'Gastei 40 no mercado categoria alimentação, dia 12',
    'Gastei 10,94 no Uber, categoria transporte, 12/11, notas voltando para casa',
    'Gastei 30 na Pão e Cia categoria alimentação',
    'Gastei 40 na loja categoria casa e jardim',
    'Gastei 100 no mercado: categorias 70 alimentação, 30 limpeza',
    'Gastei 100,50 no mercado categorias 70,50 alimentação; 30 limpeza notas compra do mês',
    'Gastei 120 na loja categoria eletrônicos notas parcela 3 de 10',
    'Quanto ainda tenho disponível em Alimentação?',
    'Posso gastar R$ 50 com Alimentação?',
    'desfazer',
  ]) {
    assert.deepEqual(check(message), { complete: true }, message);
  }
});

test('refuses a parse that swallowed a second operation in the category', () => {
  assert.deepEqual(check("Gastei 50 no McDonald's categoria alimentação e 30 no mercado"), { complete: false, reason: 'category' });
  assert.deepEqual(check("Gastei 50 no McDonald's categoria alimentação, 30 no mercado categoria livre"), { complete: false, reason: 'category' });
  assert.deepEqual(check('Gastei 50 no mercado categoria alimentação e paguei a farmácia'), { complete: false, reason: 'category' });
});

test('refuses a parse that swallowed a second operation in the description', () => {
  assert.deepEqual(check("Gastei 50 no McDonald's e 30 no mercado categoria alimentação"), { complete: false, reason: 'description' });
  assert.deepEqual(check("Gastei 50 no McDonald's e no mercado categoria alimentação"), { complete: false, reason: 'description' });
  assert.deepEqual(check('Gastei 50 no mercado R$ 20 de troco categoria alimentação'), { complete: false, reason: 'description' });
});

test('refuses notes that carry money or another operation, but not plain numbers', () => {
  assert.deepEqual(check('Gastei 50 no mercado categoria alimentação notas e recebi 20 do João'), { complete: false, reason: 'notes' });
  assert.deepEqual(check('Gastei 50 no mercado categoria alimentação notas mais R$ 20 de gorjeta'), { complete: false, reason: 'notes' });
  assert.deepEqual(check('Gastei 50 no mercado categoria alimentação notas corredor 7'), { complete: true });
});

test('refuses split categories that hide another operation', () => {
  assert.deepEqual(check('Gastei 100 no mercado categorias 70 alimentação, 30 limpeza e paguei o uber'), { complete: false, reason: 'split-category' });
});

test('refuses category questions that contain another question or operation', () => {
  assert.deepEqual(check('Quanto tenho em livre e quanto gastei no mercado?'), { complete: false, reason: 'category' });
  assert.deepEqual(check('Quanto tenho em livre? Se tiver mais de 100, registra uma compra de 80'), { complete: false, reason: 'category' });
  assert.deepEqual(check('Gastei 50 no mercado e quero saber se posso gastar 30 em lazer'), { complete: false, reason: 'category' });
});

test('the check never sees anything but the parser output and has no side effects', () => {
  assert.deepEqual(isCompleteParse(null), { complete: false, reason: 'no-intent' });
  assert.deepEqual(isCompleteParse({ kind: 'other' }), { complete: false, reason: 'unknown-kind' });
});

test('split parts must add up exactly to the total', () => {
  assert.doesNotThrow(() => checkSplitTotal([{ amount: 150 }, { amount: 150 }], 300));
  assert.throws(() => checkSplitTotal([{ amount: 150 }, { amount: 149.99 }], 300), { code: 'INVALID_COMMAND', message: /299,99.*300,00/ });
});
