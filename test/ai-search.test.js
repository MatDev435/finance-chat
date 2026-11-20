/**
 * Transaction search in AI mode, over HTTP, with simulated plans and a fake
 * budget holding fictitious transactions in two accounts. The AQL semantics
 * themselves are pinned against the real engine in search-aql.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ANA_CONNECTION, BIA_CONNECTION, signedIn, startApp } from './support/app-harness.js';
import { FAKE_KEY, op, plan } from './support/fake-openai.js';
import { currentLocalDate } from '../src/transaction-mapping.js';

const CATEGORIES = [
  { id: 'cat-food', name: 'Alimentação' },
  { id: 'cat-free', name: 'Livre' },
  { id: 'cat-health', name: 'Saúde' },
  { id: 'cat-extra', name: 'Renda extra' },
];
const PAYEES = [
  { id: 'p-mc', name: "McDonald's" },
  { id: 'p-market', name: 'Mercado Bom Preço' },
  { id: 'p-pharmacy', name: 'Farmácia Pague Menos' },
  { id: 'p-joao', name: 'João Silva' },
  { id: 'p-savings', name: 'Poupança', transfer_acct: 'acc-inter' },
];

function ago(days) {
  const [year, month, day] = currentLocalDate().split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) - days * 86_400_000).toISOString().slice(0, 10);
}

const TRANSACTIONS = [
  { id: 't1', account: 'acc-nubank', date: ago(3), amount: -3800, payee: 'p-mc', category: 'cat-food', notes: 'Big Mac e Monster' },
  { id: 't2', account: 'acc-nubank', date: ago(40), amount: -5000, payee: 'p-mc', category: 'cat-food' },
  { id: 't3', account: 'acc-nubank', date: ago(10), amount: -30000, payee: 'p-market', notes: 'Compra do mês, com monster', subtransactions: [{ amount: -15000, category: 'cat-food' }, { amount: -15000, category: 'cat-free' }] },
  { id: 't4', account: 'acc-nubank', date: ago(20), amount: -12000, payee: 'p-market', category: 'cat-food', notes: 'Pão de açúcar' },
  { id: 't5', account: 'acc-nubank', date: ago(0), amount: -4500, payee: 'p-pharmacy', category: 'cat-health' },
  { id: 't6', account: 'acc-nubank', date: ago(0), amount: -2000, payee: 'p-pharmacy', category: 'cat-health' },
  { id: 't7', account: 'acc-nubank', date: ago(5), amount: 20000, payee: 'p-joao', category: 'cat-extra' },
  { id: 't8', account: 'acc-nubank', date: ago(2), amount: -10000, payee: 'p-savings', transfer_id: 'tx-mirror' },
  { id: 't9', account: 'acc-nubank', date: '2025-03-10', amount: -7000, payee: 'p-market', category: 'cat-food' },
  { id: 't10', account: 'acc-nubank', date: '2025-03-20', amount: -3000, payee: 'p-mc', category: 'cat-food' },
  { id: 't11', account: 'acc-nubank', date: '2025-01-01', amount: 100000, payee: null, category: null, starting_balance_flag: true },
  { id: 'tI', account: 'acc-inter', date: ago(1), amount: -9999, payee: 'p-mc', category: 'cat-food', notes: 'Monster' },
];

async function searchApp() {
  const app = await startApp({ categories: CATEGORIES, anaBudget: { payees: PAYEES, transactions: TRANSACTIONS } });
  const ana = await signedIn(app, 'ana', ANA_CONNECTION);
  await ana.put('/api/ai/settings', { enabled: true, apiKey: FAKE_KEY });
  const ask = async (search, message = 'pergunta sobre transações') => {
    app.openai.replyPlan(plan({ operations: [op.search(search)] }));
    return (await ana.post('/api/chat/preview', { accountId: 'acc-nubank', message })).body;
  };
  return { app, ana, ask };
}

const money = (text) => text.replace(/ /g, ' ');

test('"Qual foi a última vez que comi no McDonald\'s?": only this chat\'s account, newest first', async () => {
  const { app, ask } = await searchApp();
  const body = await ask({ payee: 'mc donalds', type: 'expense', period: 'all', result: 'list', order: 'newest', limit: 1 });
  assert.equal(body.kind, 'search');
  assert.equal(body.source, 'ai');
  assert.deepEqual(body.search.transactions, [{ date: ago(3), amount: -3800, payee: "McDonald's", category: 'Alimentação', notes: 'Big Mac e Monster' }]);
  assert.equal(money(body.message), `A última despesa com McDonald's foi de R$ 38,00 em ${ago(3).split('-').reverse().join('/')} (Alimentação).`);
  assert.equal(body.search.account, 'Nubank');
  assert.equal(JSON.stringify(body).includes('9999'), false, 'the other account is never searched');
  await app.close();
});

test('"últimas cinco compras no mercado": a split purchase appears once, as a whole', async () => {
  const { app, ask } = await searchApp();
  const body = await ask({ payee: 'mercado', type: 'expense', period: 'all', result: 'list', order: 'newest', limit: 5 });
  assert.equal(body.search.count, 3);
  assert.deepEqual(body.search.transactions.map((t) => [t.amount, t.category]), [[-30000, 'Dividida em categorias'], [-12000, 'Alimentação'], [-7000, 'Alimentação']]);
  assert.match(money(body.message), /^Encontrei 3 despesas com Mercado Bom Preço em todo o histórico\.$/);
  await app.close();
});

test('"Quanto gastei em alimentação em março de 2025?": totals come from the backend', async () => {
  const { app, ask } = await searchApp();
  const body = await ask({ category: 'alimentacao', type: 'expense', period: 'month', month: 3, year: 2025, result: 'sum' });
  assert.deepEqual([body.search.count, body.search.total, body.search.from, body.search.to], [2, -10000, '2025-03-01', '2025-03-31']);
  assert.equal(money(body.message), 'Você gastou R$ 100,00 em Alimentação de 01/03/2025 a 31/03/2025 (2 despesas).');
  await app.close();
});

test('a category filter counts only the split part of that category', async () => {
  const { app, ask } = await searchApp();
  const body = await ask({ category: 'livre', type: 'expense', period: 'all', result: 'sum' });
  assert.deepEqual([body.search.count, body.search.total], [1, -15000]);
  await app.close();
});

test('"Quanto gastei no McDonald\'s nos últimos três meses?"', async () => {
  const { app, ask } = await searchApp();
  const body = await ask({ payee: "McDonald's", type: 'expense', period: 'last_months', periodCount: 3, result: 'sum' });
  assert.deepEqual([body.search.count, body.search.total], [2, -8800]);
  assert.match(money(body.message), /^Você gastou R\$ 88,00 com McDonald's de \d{2}\/\d{2}\/\d{4} a \d{2}\/\d{2}\/\d{4} \(2 despesas\)\.$/);
  await app.close();
});

test('"Qual foi minha maior despesa?" and transfers never count as expenses', async () => {
  const { app, ask } = await searchApp();
  const largest = await ask({ type: 'expense', period: 'all', result: 'max' });
  assert.deepEqual(largest.search.transactions.map((t) => t.amount), [-30000]);
  assert.match(money(largest.message), /^A maior despesa em todo o histórico foi de R\$ 300,00 em .*Mercado Bom Preço \(Dividida em categorias\)\.$/);
  const balance = await ask({ type: 'any', period: 'all', result: 'sum' });
  // Every Nubank transaction except the transfer (−100) and the starting balance (+1000).
  assert.deepEqual([balance.search.count, balance.search.total], [9, -47300]);
  await app.close();
});

test('"Quando recebi dinheiro do João pela última vez?"', async () => {
  const { app, ask } = await searchApp();
  const body = await ask({ payee: 'joão', type: 'income', period: 'all', result: 'list', order: 'newest', limit: 1 });
  assert.deepEqual(body.search.transactions.map((t) => [t.amount, t.payee]), [[20000, 'João Silva']]);
  assert.match(money(body.message), /^A última receita de João Silva foi de R\$ 200,00/);
  await app.close();
});

test('"Quantas vezes comprei na farmácia neste mês?"', async () => {
  const { app, ask } = await searchApp();
  const body = await ask({ payee: 'farmacia', type: 'expense', period: 'this_month', result: 'count' });
  assert.deepEqual([body.search.count, body.search.total], [2, -6500]);
  assert.match(money(body.message), /^Encontrei 2 despesas com Farmácia Pague Menos .*somando R\$ 65,00\.$/);
  await app.close();
});

test('follow-up: "e quanto gastei no total?" reuses the previous filters, sent to the model as lastSearch', async () => {
  const { app, ask } = await searchApp();
  const list = await ask({ payee: "McDonald's", type: 'expense', period: 'all', result: 'list' }, "Quais foram minhas últimas compras no McDonald's?");
  assert.equal(list.search.count, 3);
  const total = await ask({ followUp: true, result: 'sum' }, 'E quanto gastei no total?');
  assert.deepEqual([total.search.count, total.search.total, total.search.payees], [3, -11800, ["McDonald's"]]);
  const context = JSON.parse(app.openai.requests[1].body.input[1].content[0].text);
  assert.deepEqual(context.lastSearch, { payee: "McDonald's", type: 'expense', period: 'all', result: 'list' });
  const narrowed = await ask({ followUp: true, period: 'month', month: 3, year: 2025 }, 'e em março de 2025?');
  assert.deepEqual([narrowed.search.count, narrowed.search.total, narrowed.search.result], [1, -3000, 'sum']);
  await app.close();
});

test('a follow-up without a previous search asks for the full question; contexts are per user', async () => {
  const { app, ask } = await searchApp();
  await ask({ payee: "McDonald's", type: 'expense', period: 'all', result: 'list' });
  const bia = await signedIn(app, 'bia', BIA_CONNECTION);
  await bia.put('/api/ai/settings', { enabled: true, apiKey: FAKE_KEY });
  app.openai.replyPlan(plan({ operations: [op.search({ followUp: true, result: 'sum' })] }));
  const response = await bia.post('/api/chat/preview', { accountId: 'acc-carteira', message: 'e no total?' });
  assert.equal(response.body.kind, 'text');
  assert.match(response.body.message, /Não encontrei uma busca anterior/);
  await app.close();
});

test('no matching payee, an unknown category or an invalid range give clear answers', async () => {
  const { app, ask } = await searchApp();
  const nobody = await ask({ payee: 'Xyzabc', type: 'expense', period: 'all', result: 'list' });
  assert.equal(nobody.search.count, 0);
  // No payee by that name: the term is looked up in the notes, and the answer says so.
  assert.equal(nobody.message, 'Não encontrei um beneficiário chamado “Xyzabc”, então procurei nas notas das transações. Não encontrei despesas com “Xyzabc” nas notas nesta conta em todo o histórico.');
  assert.deepEqual([nobody.search.payees, nobody.search.notes, nobody.search.payeeAsNotes], [[], 'Xyzabc', true]);
  const category = await ask({ category: 'Alimentaçao extra', type: 'expense', period: 'all', result: 'sum' });
  assert.equal(category.kind, 'text');
  assert.match(category.message, /não existe no Actual Budget/);
  const range = await ask({ period: 'range', from: '2026-10-31', to: '2026-10-01', result: 'sum' });
  assert.match(range.message, /data inicial da busca é depois da data final/);
  await app.close();
});

test('the plan cannot widen the search: unknown fields such as an account are dropped', async () => {
  const { app, ana } = await searchApp();
  const raw = plan({ operations: [op.search({ payee: "McDonald's", type: 'expense', period: 'all', result: 'sum' })] });
  raw.operations[0].search.account = 'acc-inter';
  raw.operations[0].accountId = 'acc-inter';
  app.openai.replyPlan(raw);
  const { body } = await ana.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'quanto gastei no mc em todas as contas?' });
  assert.deepEqual([body.search.account, body.search.total], ['Nubank', -11800]);
  await app.close();
});

test('"Quanto gastei com Monster?": the notes are searched (case and accents ignored), in this account only', async () => {
  const { app, ask } = await searchApp();
  const monster = await ask({ notes: 'MONSTER', type: 'expense', period: 'all', result: 'sum' });
  // t1 (38,00) + t3 (300,00, the whole split purchase once); the other account's "Monster" is not counted.
  assert.deepEqual([monster.search.count, monster.search.total, monster.search.notes], [2, -33800, 'MONSTER']);
  assert.equal(money(monster.message), 'Você gastou R$ 338,00 com “MONSTER” nas notas em todo o histórico (2 despesas).');
  const pao = await ask({ notes: 'pao de acucar', type: 'expense', period: 'all', result: 'list' });
  assert.deepEqual(pao.search.transactions.map((transaction) => transaction.notes), ['Pão de açúcar']);
  await app.close();
});

test('a payee that does not exist is looked up in the notes; with a category, a split purchase\'s note counts for its part', async () => {
  const { app, ask } = await searchApp();
  const fallback = await ask({ payee: 'monster', type: 'expense', period: 'all', result: 'count' });
  assert.equal(fallback.search.count, 2);
  assert.match(fallback.message, /^Não encontrei um beneficiário chamado “monster”, então procurei nas notas/);
  const food = await ask({ notes: 'monster', category: 'alimentação', type: 'expense', period: 'all', result: 'sum' });
  // t1 (food, 38,00) + the food part of t3 (150,00): the free part is not counted.
  assert.deepEqual([food.search.count, food.search.total], [2, -18800]);
  // A payee that exists is never replaced by a notes search.
  const mc = await ask({ payee: 'mcdonalds', type: 'expense', period: 'all', result: 'count' });
  assert.deepEqual([mc.search.payees, mc.search.notes, mc.search.payeeAsNotes], [["McDonald's"], null, false]);
  await app.close();
});
