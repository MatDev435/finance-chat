import test from 'node:test';
import assert from 'node:assert/strict';
import { amountToCents, parseCommand, parseMessage } from '../src/parser.js';

test('parses an expense with a multi-word description', () => {
  assert.deepEqual(parseCommand("Gastei 40 reais no MCDonald's categoria alimentação"), {
    type: 'expense', amount: 40, description: "MCDonald's", category: 'Alimentação'
  });
});

test('parses income and Brazilian decimals', () => {
  assert.deepEqual(parseCommand('ganhei 250,50 freelance categoria salário mensal'), {
    type: 'income', amount: 250.5, description: 'freelance', category: 'Salário mensal'
  });
});

test('supports additional expense and income keywords', () => {
  assert.equal(parseCommand('COMPREI 50 na farmácia categoria saúde').type, 'expense');
  assert.equal(parseCommand('Mandei 100 para o João categoria transferência').type, 'expense');
  assert.equal(parseCommand('Recebi 200 da empresa categoria salário').type, 'income');
});

test('supports currency symbols, separated symbols, and both grouping conventions', () => {
  assert.equal(parseCommand('gastei R$30 no mercado categoria alimentação').amount, 30);
  assert.equal(parseCommand('gastei r$ 30,50 no mercado categoria alimentação').amount, 30.5);
  assert.equal(parseCommand('gastei $ 1.500 no mercado categoria alimentação').amount, 1500);
  assert.equal(parseCommand('recebi R$ 1.500,50 da empresa categoria salário').amount, 1500.5);
  assert.equal(parseCommand('recebi 1,500.50 da empresa categoria salário').amount, 1500.5);
});

test('removes supported beneficiary prepositions without losing multi-word names', () => {
  assert.equal(parseCommand('gastei 30 na farmácia categoria saúde').description, 'farmácia');
  assert.equal(parseCommand('gastei 30 para minha mãe categoria presentes').description, 'minha mãe');
  assert.equal(parseCommand('gastei 30 pra minha mãe categoria presentes').description, 'minha mãe');
  assert.equal(parseCommand('gastei 30 pro João categoria transferência').description, 'João');
  assert.equal(parseCommand('recebi 100 do cliente categoria pagamento').description, 'cliente');
});

test('normalizes whitespace and amount cents', () => {
  assert.equal(parseCommand('  GASTEI   1.234,50   mercado   categoria   alimentação  ').amount, 1234.5);
  assert.equal(amountToCents(1234.5), 123450);
});

test('parses an optional note after the category', () => {
  assert.deepEqual(parseCommand('Gastei 10 reais e 94 centavos no Uber, categoria transporte, notas indo para tal lugar.'), {
    type: 'expense', amount: 10.94, description: 'Uber', category: 'Transporte', notes: 'Indo para tal lugar',
  });
});

test('does not add notes to commands without a note marker', () => {
  const command = parseCommand("Gastei 50 reais no McDonald's, categoria alimentação");
  assert.equal(command.notes, undefined);
  assert.equal(command.description, "McDonald's");
  assert.equal(command.category, 'Alimentação');
});

test('parses category availability questions with or without punctuation', () => {
  assert.deepEqual(parseMessage('Quanto eu tenho disponível na categoria Alimentação esse mês?'), { kind: 'category-available', category: 'Alimentação' });
  assert.deepEqual(parseMessage('Quanto ainda posso gastar em Alimentação esse mês'), { kind: 'category-available', category: 'Alimentação' });
  assert.deepEqual(parseMessage('Quanto ainda tenho disponível para gastar com Alimentação'), { kind: 'category-available', category: 'Alimentação' });
});

test('parses category spending checks with reusable amount rules', () => {
  assert.deepEqual(parseMessage('Posso gastar R$ 50 com Alimentação?'), { kind: 'category-can-spend', amount: 50, category: 'Alimentação' });
  assert.deepEqual(parseMessage('Tenho R$ 50 para gastar em Alimentação'), { kind: 'category-can-spend', amount: 50, category: 'Alimentação' });
  assert.deepEqual(parseMessage('Dá para gastar 50,50 na categoria alimentação'), { kind: 'category-can-spend', amount: 50.5, category: 'Alimentação' });
});

for (const input of [
  'paguei 10 loja categoria casa',
  'gastei loja categoria casa',
  'gastei 0 loja categoria casa',
  'gastei -10 loja categoria casa',
  'gastei 10 categoria casa',
  'gastei 10 loja',
]) {
  test(`rejects invalid command: ${input}`, () => assert.throws(() => parseCommand(input)));
}
