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

test('a date before the command or at the end of the category is recognized', () => {
  assert.deepEqual(parseCommand('Ontem gastei 40 reais no mercado categoria alimentação'), {
    type: 'expense', amount: 40, description: 'mercado', category: 'Alimentação', when: { daysAgo: 1 },
  });
  assert.deepEqual(parseCommand('Gastei 40 no mercado categoria alimentação, dia 12').when, { day: 12, month: null, year: null });
  assert.deepEqual(parseCommand('No dia 3/11/2026, recebi 100 da empresa categoria salário').when, { day: 3, month: 11, year: 2026 });
  assert.deepEqual(parseCommand('anteontem comprei 9,90 na padaria categoria alimentação').when, { daysAgo: 2 });
});

test('a date before notes is a date; inside notes it is just text', () => {
  const command = parseCommand('Gastei 10,94 no Uber, categoria transporte, 12/11, notas voltando de ontem');
  assert.equal(command.category, 'Transporte');
  assert.deepEqual(command.when, { day: 12, month: 11, year: null });
  assert.equal(command.notes, 'Voltando de ontem');
  const notesOnly = parseCommand('Gastei 10 no Uber categoria transporte notas jantar de ontem');
  assert.equal(notesOnly.when, undefined);
});

test('messages without a date expression are interpreted exactly as before', () => {
  assert.equal('when' in parseCommand('Gastei 40 no mercado categoria alimentação'), false);
  assert.equal(parseCommand('Gastei 40 no mercado categoria Hoje').category, 'Hoje', 'a category alone is never taken as a date');
  assert.equal(parseCommand('Gastei 40 na loja categoria dia das mães').category, 'Dia das mães');
  assert.equal(parseCommand('Gastei 40 no posto categoria transporte').description, 'posto');
});

test('rejects a date given twice', () => {
  assert.throws(() => parseCommand('Ontem gastei 40 no mercado categoria alimentação dia 12'), /data só uma vez/);
});

test('splits a purchase across categories with "categorias"', () => {
  assert.deepEqual(parseCommand('Gastei 100 no mercado: categorias 70 alimentação, 30 limpeza'), {
    type: 'expense', amount: 100, description: 'mercado',
    splits: [{ amount: 70, category: 'Alimentação' }, { amount: 30, category: 'Limpeza' }],
  });
  const valueLast = parseCommand('Gastei 100 no mercado categorias alimentação 70 e limpeza R$ 30 ontem notas compra do mês');
  assert.deepEqual(valueLast.splits, [{ amount: 70, category: 'Alimentação' }, { amount: 30, category: 'Limpeza' }]);
  assert.deepEqual(valueLast.when, { daysAgo: 1 });
  assert.equal(valueLast.notes, 'Compra do mês');
});

test('split parts keep decimal commas and category names containing "e"', () => {
  assert.deepEqual(parseCommand('Gastei 100,50 no mercado categorias 70,50 alimentação, 30 limpeza').splits.map((s) => s.amount), [70.5, 30]);
  assert.deepEqual(parseCommand('Gastei 100 no mercado categorias Casa e jardim 40 e alimentação 60').splits, [
    { amount: 40, category: 'Casa e jardim' }, { amount: 60, category: 'Alimentação' },
  ]);
  assert.deepEqual(parseCommand('Recebi 1.000 da empresa categorias 800 salário; 200 de bônus').splits, [
    { amount: 800, category: 'Salário' }, { amount: 200, category: 'Bônus' },
  ]);
  assert.deepEqual(parseCommand('Gastei 100 no mercado categorias 70 reais de alimentação e 30 reais em limpeza').splits.map((s) => s.category), ['Alimentação', 'Limpeza']);
});

test('split parts must add up to the total and be well formed', () => {
  assert.throws(() => parseCommand('Gastei 100 no mercado categorias 70 alimentação, 20 limpeza'), /soma das partes \(R\$\s?90,00\) é diferente do total \(R\$\s?100,00\)/);
  assert.throws(() => parseCommand('Gastei 100 no mercado categorias 100 alimentação'), /pelo menos duas partes/);
  assert.throws(() => parseCommand('Gastei 100 no mercado categorias alimentação, limpeza'), /Não entendi a parte/);
  assert.throws(() => parseCommand('Gastei 100 no mercado categorias'), /partes depois de “categorias”/);
  const eleven = Array.from({ length: 11 }, (_, i) => `1 c${i}`).join(', ');
  assert.throws(() => parseCommand(`Gastei 11 no mercado categorias ${eleven}`), /no máximo 10 partes/);
});

test('"categoria" keeps priority: messages accepted before are parsed exactly as before', () => {
  assert.deepEqual(parseCommand('Gastei 30 na loja de categorias categoria presentes'), {
    type: 'expense', amount: 30, description: 'loja de categorias', category: 'Presentes',
  });
  assert.equal('splits' in parseCommand('Gastei 30 na loja categoria presentes'), false);
});

test('recognizes the undo command in a few natural forms only', () => {
  for (const text of ['desfazer', 'Desfazer!', 'desfaz o último', 'desfazer o ultimo lançamento', 'Desfaça o último registro']) {
    assert.deepEqual(parseMessage(text), { kind: 'undo' }, text);
  }
  assert.throws(() => parseMessage('desfazer 40 reais'));
  assert.notDeepEqual(parseMessage('Gastei 10 no desfazer categoria lazer'), { kind: 'undo' });
});

test('recognizes a few fixed month-summary phrases (free variations go to the AI)', () => {
  for (const text of ['resumo', 'Resumo do mês', 'me mostra o resumo do mês', 'quero um resumo', 'como estou esse mês?', 'Como estão minhas finanças?', 'como tá o mês?', 'como estou']) {
    assert.deepEqual(parseMessage(text), { kind: 'summary', period: 'this_month' }, text);
  }
  for (const text of ['resumo do mês passado', 'Como foi o mês passado?']) {
    assert.deepEqual(parseMessage(text), { kind: 'summary', period: 'last_month' }, text);
  }
  for (const text of ['resumo de outubro', 'resumos', 'como estou gastando?']) assert.throws(() => parseMessage(text), text);
  assert.equal(parseMessage('Gastei 10 no mercado categoria resumo').kind, 'transaction');
});

test('"quanto gastei com X [período] [por mês]" becomes a search of the chat account', () => {
  const search = (text) => parseMessage(text).search;
  const pick = ({ term, type, period, periodCount, month, year, result }) => ({ term, type, period, periodCount, month, year, result });
  assert.deepEqual(pick(search('quanto gastei com alimentação')), { term: 'alimentação', type: 'expense', period: 'all', periodCount: null, month: null, year: null, result: 'sum' });
  assert.deepEqual(pick(search('Quanto gastei com alimentação em outubro?')), { term: 'alimentação', type: 'expense', period: 'month', periodCount: null, month: 10, year: null, result: 'sum' });
  assert.deepEqual(pick(search('quanto gastei com alimentação em março de 2025')), { term: 'alimentação', type: 'expense', period: 'month', periodCount: null, month: 3, year: 2025, result: 'sum' });
  assert.deepEqual(pick(search('quanto gastei com alimentação nos últimos 3 meses por mês')), { term: 'alimentação', type: 'expense', period: 'last_months', periodCount: 3, month: null, year: null, result: 'by_month' });
  assert.deepEqual(pick(search('quanto gastei por mês com alimentação')), { term: 'alimentação', type: 'expense', period: null, periodCount: null, month: null, year: null, result: 'by_month' });
  assert.equal(search('quanto gastei com alimentação por mês nos últimos seis meses').periodCount, 6);
  assert.deepEqual(pick(search('quanto recebi de freela este ano')), { term: 'freela', type: 'income', period: 'this_year', periodCount: null, month: null, year: null, result: 'sum' });
  assert.equal(search("Quanto eu gastei no McDonald's mês passado?").term, "McDonald's");
  assert.equal(search('quanto paguei no mercado esse mês').period, 'this_month');
  assert.deepEqual([search('quanto gastei em outubro').term, search('quanto gastei no total esse mês').term], [null, null]);
  assert.equal(search('quanto gastei com alimentação em 2025').year, 2025);
  // Terms that still carry another date, filter or question are never guessed.
  for (const text of ['quanto gastei hoje no uber', 'quanto gastei em março de 2025 com alimentação', 'quanto gastei com alimentação e no mercado']) {
    assert.throws(() => parseMessage(text), /quanto gastei com alimentação em outubro/, text);
  }
  // "Quanto tenho em X?" is still the category balance.
  assert.equal(parseMessage('quanto tenho em alimentação').kind, 'category-available');
});

test('dictated text (voice transcripts) parses like typed text: final period, commas after keywords', () => {
  assert.deepEqual(parseCommand('Gastei 40 reais no mercado, categoria, alimentação.'), {
    type: 'expense', amount: 40, description: 'mercado', category: 'Alimentação',
  });
  assert.deepEqual(parseCommand('Gastei R$ 40,00 no mercado categoria alimentação, notas, compra do mês.'), {
    type: 'expense', amount: 40, description: 'mercado', category: 'Alimentação', notes: 'Compra do mês',
  });
  assert.equal(parseCommand('Gastei 100 no mercado categorias, 70 alimentação, 30 limpeza.').splits.length, 2);
  const search = parseMessage('Quanto gastei com transporte, nos últimos três meses, por mês.').search;
  assert.deepEqual([search.term, search.period, search.periodCount, search.result], ['transporte', 'last_months', 3, 'by_month']);
  assert.deepEqual(parseMessage('Desfazer.'), { kind: 'undo' });
});
