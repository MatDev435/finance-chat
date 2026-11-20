/**
 * Month summary, over HTTP: the fixed phrases are answered by the parser
 * (no OpenAI call, AI on or off), free variations by a simulated plan. Every
 * number comes from the fake budget; nothing is ever written.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ANA_CONNECTION, signedIn, startApp } from './support/app-harness.js';
import { FAKE_KEY, op, plan } from './support/fake-openai.js';
import { budgetOverview, summaryRange } from '../src/summary.js';
import { currentLocalDate } from '../src/transaction-mapping.js';

const TODAY = currentLocalDate();
const MONTH = TODAY.slice(0, 7);
const FIRST = `${MONTH}-01`;
const CATEGORIES = [
  { id: 'cat-food', name: 'Alimentação' },
  { id: 'cat-free', name: 'Livre' },
  { id: 'cat-health', name: 'Saúde' },
  { id: 'cat-salary', name: 'Salário', is_income: true },
];
const PAYEES = [{ id: 'p-market', name: 'Mercado' }, { id: 'p-pharmacy', name: 'Farmácia' }, { id: 'p-work', name: 'Empresa' }, { id: 'p-savings', name: 'Poupança', transfer_acct: 'acc-inter' }];
const TRANSACTIONS = [
  { id: 't1', account: 'acc-nubank', date: FIRST, amount: -30000, payee: 'p-market', subtransactions: [{ amount: -20000, category: 'cat-food' }, { amount: -10000, category: 'cat-free' }] },
  { id: 't2', account: 'acc-nubank', date: FIRST, amount: -4500, payee: 'p-pharmacy', category: 'cat-health' },
  { id: 't3', account: 'acc-nubank', date: TODAY, amount: -1200, payee: 'p-market', category: 'cat-food' },
  { id: 't4', account: 'acc-nubank', date: TODAY, amount: -800, payee: 'p-market', category: 'cat-food' },
  { id: 't5', account: 'acc-nubank', date: FIRST, amount: 500000, payee: 'p-work', category: 'cat-salary' },
  { id: 't6', account: 'acc-nubank', date: TODAY, amount: -100000, payee: 'p-savings', transfer_id: 'mirror' },
  { id: 't7', account: 'acc-nubank', date: FIRST, amount: 999999, starting_balance_flag: true },
  { id: 't8', account: 'acc-inter', date: TODAY, amount: -7777, payee: 'p-market', category: 'cat-food' },
];
const BUDGET_MONTH = {
  categoryGroups: [
    { id: 'g1', name: 'Despesas', categories: [
      { id: 'cat-food', name: 'Alimentação', budgeted: 25000, spent: -29777, balance: -4777 },
      { id: 'cat-free', name: 'Livre', budgeted: 20000, spent: -10000, balance: 10000 },
      { id: 'cat-health', name: 'Saúde', budgeted: 5000, spent: -4500, balance: 500 },
    ] },
    { id: 'g2', name: 'Receitas', is_income: true, categories: [{ id: 'cat-salary', name: 'Salário', is_income: true, received: 500000 }] },
  ],
};

async function summaryApp({ ai = false, months = { [MONTH]: BUDGET_MONTH } } = {}) {
  const app = await startApp({ categories: CATEGORIES, anaBudget: { payees: PAYEES, transactions: TRANSACTIONS, months } });
  const ana = await signedIn(app, 'ana', ANA_CONNECTION);
  if (ai) await ana.put('/api/ai/settings', { enabled: true, apiKey: FAKE_KEY });
  const send = async (message) => (await ana.post('/api/chat/preview', { accountId: 'acc-nubank', message })).body;
  return { app, send };
}

const money = (text) => text.replace(/\u00a0/g, ' ');

test('"como estou esse mês?" without AI: account totals and the budget of the month, from the budget only', async () => {
  const { app, send } = await summaryApp();
  const body = await send('como estou esse mês?');
  assert.equal(body.kind, 'summary');
  assert.equal(body.source, 'parser');
  const view = body.summary;
  assert.deepEqual([view.month, view.from, view.to, view.account], [MONTH, FIRST, TODAY, 'Nubank']);
  // Transfers, the starting balance and the other account are left out; the split purchase counts once.
  assert.deepEqual([view.expenses, view.expenseCount, view.incomes, view.incomeCount, view.net], [36500, 4, 500000, 1, 463500]);
  assert.deepEqual(view.topExpenses.map((expense) => [expense.amount, expense.payee, expense.category]), [
    [-30000, 'Mercado', 'Dividida em categorias'], [-4500, 'Farmácia', 'Saúde'], [-1200, 'Mercado', 'Alimentação'],
  ]);
  assert.deepEqual(view.budget, {
    budgeted: 50000, spent: 44277,
    topCategories: [{ name: 'Alimentação', spent: 29777 }, { name: 'Livre', spent: 10000 }, { name: 'Saúde', spent: 4500 }],
    overspent: [{ name: 'Alimentação', balance: -4777 }], overspentCount: 1,
  });
  const text = money(body.message);
  assert.match(text, /^Resumo de \S+ de \d{4} \(/);
  assert.match(text, /• Despesas: R\$ 365,00 \(4 lançamentos\)/);
  assert.match(text, /• Resultado: \+R\$ 4\.635,00/);
  assert.match(text, /• Gasto: R\$ 442,77 de R\$ 500,00 orçados/);
  assert.match(text, /• Categorias estouradas: Alimentação \(faltam R\$ 47,77\)/);
  assert.equal(app.budget.transactions.length, TRANSACTIONS.length, 'nothing is written');
  await app.close();
});

test('with the AI on, the fixed phrases still never call OpenAI', async () => {
  const { app, send } = await summaryApp({ ai: true });
  for (const message of ['resumo do mês', 'Como foi o mês passado?']) assert.equal((await send(message)).kind, 'summary');
  assert.equal(app.openai.requests.length, 0);
  await app.close();
});

test('the AI names the month; a month outside the budget still answers the account part', async () => {
  const { app, send } = await summaryApp({ ai: true, months: { [MONTH]: BUDGET_MONTH, '2025-10': new Error('No budget exists for month: 2025-10') } });
  app.openai.replyPlan(plan({ operations: [op.summary({ period: 'month', month: 10, year: 2025 })] }));
  const body = await send('me faz um resumo de outubro do ano passado');
  assert.equal(body.kind, 'summary');
  assert.equal(body.source, 'ai');
  assert.deepEqual([body.summary.from, body.summary.to, body.summary.budget], ['2025-10-01', '2025-10-31', null]);
  assert.match(body.message, /Nenhuma despesa ou receita no período/);
  assert.match(body.message, /O orçamento não tem dados deste mês/);
  const context = JSON.parse(app.openai.requests[0].body.input[1].content[0].text);
  assert.equal(JSON.stringify(context).includes('36500'), false, 'no budget numbers are sent to the model');
  await app.close();
});

test('a summary mixed with a transaction answers only the summary; a month that has not started is refused', async () => {
  const { app, send } = await summaryApp({ ai: true });
  app.openai.replyPlan(plan({ operations: [op.summary(), op.tx({ amount: '10', payee: 'padaria', category: 'alimentação' })] }));
  const mixed = await send('como estou? e registra 10 na padaria em alimentação');
  assert.equal(mixed.kind, 'summary');
  assert.match(mixed.notes[0], /Não registrei nenhuma movimentação/);
  const [year] = TODAY.split('-').map(Number);
  app.openai.replyPlan(plan({ operations: [op.summary({ period: 'month', month: 1, year: year + 1 })] }));
  const future = await send('resumo de janeiro do ano que vem');
  assert.deepEqual([future.kind, future.message], ['text', 'Esse mês ainda não começou.']);
  assert.equal(app.budget.transactions.length, TRANSACTIONS.length);
  await app.close();
});

test('summary ranges and the budget overview (pure)', () => {
  assert.deepEqual(summaryRange({ period: 'this_month' }, '2026-11-20'), { month: '2026-11', from: '2026-11-01', to: '2026-11-20' });
  assert.deepEqual(summaryRange({ period: 'last_month' }, '2026-01-05'), { month: '2025-12', from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(summaryRange({ period: 'month', month: 12, year: null }, '2026-11-20'), { month: '2025-12', from: '2025-12-01', to: '2025-12-31' });
  const many = budgetOverview({ categoryGroups: [{ categories: Array.from({ length: 7 }, (_, index) => ({ name: `C${index}`, budgeted: 0, spent: -(index + 1), balance: -(index + 1) })) }] });
  assert.equal(many.overspent.length, 5);
  assert.equal(many.overspentCount, 7);
  assert.deepEqual(many.overspent[0], { name: 'C6', balance: -7 });
  assert.deepEqual(budgetOverview(null), { budgeted: 0, spent: 0, topCategories: [], overspent: [], overspentCount: 0 });
});
