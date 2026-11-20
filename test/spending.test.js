/**
 * "Quanto gastei com X?", over HTTP: the parser answers the common phrasing
 * (a category or a payee, with an optional period and "por mês"); the AI
 * answers the rest, including month-by-month totals. Fictitious budget only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ANA_CONNECTION, signedIn, startApp } from './support/app-harness.js';
import { FAKE_KEY, op, plan } from './support/fake-openai.js';
import { currentLocalDate } from '../src/transaction-mapping.js';

const TODAY = currentLocalDate();
const [YEAR, MONTH] = TODAY.split('-').map(Number);
/** The 1st of the month `back` months ago ('YYYY-MM-01'). */
function monthStart(back) {
  const total = YEAR * 12 + (MONTH - 1) - back;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}
const key = (date) => date.slice(0, 7);

const CATEGORIES = [{ id: 'cat-food', name: 'Alimentação' }, { id: 'cat-free', name: 'Livre' }];
const PAYEES = [{ id: 'p-market', name: 'Mercado Bom Preço' }, { id: 'p-mc', name: "McDonald's" }, { id: 'p-work', name: 'Empresa' }];
const TRANSACTIONS = [
  { id: 't1', account: 'acc-nubank', date: monthStart(2), amount: -10000, payee: 'p-market', category: 'cat-food' },
  { id: 't2', account: 'acc-nubank', date: monthStart(2), amount: -2500, payee: 'p-mc', category: 'cat-food' },
  { id: 't3', account: 'acc-nubank', date: monthStart(0), amount: -4000, payee: 'p-market', subtransactions: [{ amount: -3000, category: 'cat-food' }, { amount: -1000, category: 'cat-free' }] },
  { id: 't4', account: 'acc-nubank', date: monthStart(0), amount: 300000, payee: 'p-work', category: null },
  { id: 't5', account: 'acc-inter', date: monthStart(0), amount: -9999, payee: 'p-market', category: 'cat-food' },
];

async function spendingApp({ ai = false } = {}) {
  const app = await startApp({ categories: CATEGORIES, anaBudget: { payees: PAYEES, transactions: TRANSACTIONS } });
  const ana = await signedIn(app, 'ana', ANA_CONNECTION);
  if (ai) await ana.put('/api/ai/settings', { enabled: true, apiKey: FAKE_KEY });
  const send = async (message) => (await ana.post('/api/chat/preview', { accountId: 'acc-nubank', message })).body;
  return { app, send };
}

const money = (text) => text.replace(/\u00a0/g, ' ');

test('without AI: "quanto gastei com alimentação" sums the category; "no mercado" is a payee', async () => {
  const { app, send } = await spendingApp();
  const food = await send('quanto gastei com alimentação');
  assert.deepEqual([food.kind, food.source, food.search.category, food.search.total, food.search.count], ['search', 'parser', 'Alimentação', -15500, 3]);
  assert.equal(money(food.message), 'Você gastou R$ 155,00 em Alimentação em todo o histórico (3 despesas).');
  const market = await send('quanto paguei no mercado bom preço?');
  assert.deepEqual([market.search.payees, market.search.category, market.search.total], [['Mercado Bom Preço'], null, -14000]);
  const income = await send('quanto recebi da empresa este mês');
  assert.deepEqual([income.search.type, income.search.total], ['income', 300000]);
  assert.equal(app.openai.requests.length, 0);
  await app.close();
});

test('month filter and month by month (empty months included)', async () => {
  const { app, send } = await spendingApp();
  const months = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const [year, month] = monthStart(2).split('-').map(Number);
  const one = await send(`quanto gastei com alimentação em ${months[month - 1]} de ${year}?`);
  assert.deepEqual([one.search.from, one.search.total, one.search.count], [monthStart(2), -12500, 2]);

  const monthly = await send('quanto gastei com alimentação nos últimos 3 meses por mês');
  assert.equal(monthly.search.result, 'by_month');
  assert.deepEqual(monthly.search.months, [
    { month: key(monthStart(2)), count: 2, total: -12500 },
    { month: key(monthStart(1)), count: 0, total: 0 },
    { month: key(monthStart(0)), count: 1, total: -3000 },
  ]);
  assert.match(money(monthly.message), /Por mês:\n\n• \S+ de \d{4}: R\$ 125,00 \(2 despesas\)\n• \S+ de \d{4}: R\$ 0,00\n• \S+ de \d{4}: R\$ 30,00 \(1 despesa\)$/);
  await app.close();
});

test('with AI: a term that matches the budget is answered by the parser; an unknown one goes, whole, to the AI', async () => {
  const { app, send } = await spendingApp({ ai: true });
  assert.equal((await send('quanto gastei com alimentação este mês')).source, 'parser');
  assert.equal((await send("quanto gastei no mcdonalds")).source, 'parser');
  assert.equal(app.openai.requests.length, 0);
  app.openai.replyPlan(plan({ operations: [op.search({ payee: "McDonald's", type: 'expense', period: 'all', result: 'sum' })] }));
  const partial = await send('quanto gastei no mc em todas as contas?');
  assert.deepEqual([partial.source, partial.search.account, partial.search.total], ['ai', 'Nubank', -2500]);
  assert.equal(app.openai.requests.length, 1);
  await app.close();
});

test('the AI asks for month by month: no period means this year; a follow-up "e por mês?" keeps the filters', async () => {
  const { app, send } = await spendingApp({ ai: true });
  app.openai.replyPlan(plan({ operations: [op.search({ category: 'alimentação', type: 'expense', result: 'by_month' })] }));
  const year = await send('quanto gastei com alimentação mês a mês, separado?');
  assert.equal(year.search.from, `${YEAR}-01-01`);
  assert.equal(year.search.months.length, MONTH);

  await send('quanto gastei com alimentação nos últimos 3 meses');
  app.openai.replyPlan(plan({ operations: [op.search({ followUp: true, result: 'by_month' })] }));
  const followUp = await send('e separado por mês?');
  // Same category and the same "últimos 3 meses", now as the last 3 calendar months.
  assert.deepEqual([followUp.search.category, followUp.search.from, followUp.search.months.length, followUp.search.total], ['Alimentação', monthStart(2), 3, -15500]);
  const context = JSON.parse(app.openai.requests[1].body.input[1].content[0].text);
  assert.equal(context.lastSearch.term, 'alimentação', 'the parsed search is the follow-up context');

  app.openai.replyPlan(plan({ operations: [op.search({ type: 'expense', period: 'last_months', periodCount: 36, result: 'by_month' })] }));
  const long = await send('quanto gastei por mês nos últimos 3 anos');
  assert.deepEqual([long.search.months.length, long.search.truncated], [24, true]);
  assert.match(long.message, /Mostrei só os últimos 24 meses\.$/);
  await app.close();
});
