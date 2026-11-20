import test from 'node:test';
import assert from 'node:assert/strict';
import { chartModel } from '../public/js/month-chart.js';

const plain = (text) => text.replace(/ /g, ' ');

test('one bar per month, scaled to the highest, with full text for screen readers', () => {
  const model = chartModel({
    type: 'expense', category: 'Alimentação', from: '2026-07-20', to: '2026-11-20',
    months: [
      { month: '2026-07', count: 1, total: -2000 }, { month: '2026-08', count: 0, total: 0 },
      { month: '2026-09', count: 2, total: -12500 }, { month: '2026-10', count: 1, total: -6250 }, { month: '2026-11', count: 1, total: -3000 },
    ],
  });
  assert.equal(model.title, 'Despesas por mês');
  assert.equal(model.summary, 'Gráfico de barras com 5 meses, de Julho de 2026 a Novembro de 2026, Alimentação.');
  assert.deepEqual(model.bars.map((bar) => bar.height), [16, 0, 100, 50, 24]);
  assert.deepEqual(model.bars.map((bar) => bar.short), ['jul*', 'ago', 'set', 'out', 'nov']);
  assert.equal(plain(model.bars[0].srText), 'Julho de 2026 (a partir de 20/07/2026): R$ 20,00, 1 despesa.');
  assert.equal(plain(model.bars[1].srText), 'Agosto de 2026: R$ 0,00, sem despesas.');
  assert.equal(plain(model.bars[2].srText), 'Setembro de 2026: R$ 125,00, 2 despesas.');
  assert.deepEqual([plain(model.bars[2].compactText), plain(model.bars[0].compactText)], ['R$ 125', 'R$ 20']);
  assert.deepEqual(model.legend.map(plain), ['Maior: Setembro de 2026 (R$ 125,00)', 'Média: R$ 47,50 por mês']);
  assert.equal(model.note, '* Julho a partir de 20/07/2026.');
});

test('balances keep their sign; years are shown when the range crosses one; long ranges scroll', () => {
  const model = chartModel({ type: 'any', from: '2025-12-01', months: [{ month: '2025-12', count: 1, total: -5000 }, { month: '2026-01', count: 1, total: 10000 }] });
  assert.deepEqual(model.bars.map((bar) => [bar.short, bar.height, bar.negative]), [['dez/25', 50, true], ['jan/26', 100, false]]);
  assert.match(plain(model.bars[0].srText), /-R\$ 50,00 negativo, 1 transação\.$/);
  assert.equal(model.note, null);
  const long = chartModel({ type: 'expense', from: '2025-01-01', months: Array.from({ length: 12 }, (_, i) => ({ month: `2025-${String(i + 1).padStart(2, '0')}`, count: 0, total: 0 })) });
  assert.equal(long.bars.length, 12);
  assert.equal(long.legend[0], 'Nenhum valor no período');
  assert.equal(chartModel({ months: [{ month: '2026-11', count: 1, total: -1 }] }), null);
});

test('short bar labels', () => {
  const model = chartModel({ type: 'expense', from: '2026-01-01', months: [{ month: '2026-01', count: 1, total: -750 }, { month: '2026-02', count: 1, total: -123456 }] });
  assert.deepEqual(model.bars.map((bar) => plain(bar.compactText)), ['R$ 7,50', 'R$ 1,2 mil']);
  assert.equal(plain(model.bars[1].srText), 'Fevereiro de 2026: R$ 1.234,56, 1 despesa.');
});
