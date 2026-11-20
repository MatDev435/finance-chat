/**
 * Month summary ("como estou esse mês?"): read-only numbers computed from the
 * budget, shown with a deterministic template. Nothing financial is ever sent
 * to the model: it only names the month (or the parser recognizes the phrase).
 *
 * Two clearly separated parts:
 * - the chat's account, from the transactions (AQL, same rules as the search:
 *   transfers and the starting balance excluded, split purchases counted once);
 * - the whole budget for that month (all accounts), from getBudgetMonth():
 *   budgeted, spent, the categories with the most spending and the overspent
 *   ones. Income categories are left out.
 */
import { requireChatAccount } from './accounts.js';
import { monthSummaryText } from './chat-text.js';
import { resolvePeriod } from './periods.js';
import { currentLocalDate } from './transaction-mapping.js';

export const TOP_EXPENSES = 3;
export const TOP_CATEGORIES = 3;
export const MAX_OVERSPENT = 5;
const FIELDS = ['id', 'date', 'amount', 'payee', 'category', 'notes', 'is_parent'];

const textAnswer = (message) => ({ ok: true, kind: 'text', message });

/** { period: this_month | last_month | month, month?, year? } → { month: 'YYYY-MM', from, to } (to never after today). */
export function summaryRange(request, today) {
  const spec = request.period === 'month' ? { period: 'month', month: request.month, year: request.year } : { period: request.period };
  const { from, to } = resolvePeriod(spec, today);
  return { month: from.slice(0, 7), from, to };
}

/** Expenses, incomes and the largest expenses of one account in a date range (cents, read-only). */
export async function accountTotals(api, { accountId, from, to }) {
  const base = (amount) => api.q('transactions')
    .filter({ account: accountId, transfer_id: null, starting_balance_flag: false, date: [{ $gte: from }, { $lte: to }], amount })
    .options({ splits: 'none' });
  const scalar = async (query, expression) => Number((await api.aqlQuery(query.calculate(expression))).data) || 0;
  const expensesQuery = base({ $lt: 0 });
  const incomesQuery = base({ $gt: 0 });
  const expenseCount = await scalar(expensesQuery, { $count: '$id' });
  const incomeCount = await scalar(incomesQuery, { $count: '$id' });
  const expenses = expenseCount ? -(await scalar(expensesQuery, { $sum: '$amount' })) : 0;
  const incomes = incomeCount ? await scalar(incomesQuery, { $sum: '$amount' }) : 0;
  const top = expenseCount
    ? (await api.aqlQuery(expensesQuery.orderBy([{ amount: 'asc' }, { date: 'desc' }]).limit(TOP_EXPENSES).select(FIELDS))).data || []
    : [];
  return { expenses, expenseCount, incomes, incomeCount, top };
}

/** The budget month (all accounts) reduced to what the summary shows. Amounts in cents, spending as positive numbers. */
export function budgetOverview(budgetMonth) {
  const categories = (budgetMonth?.categoryGroups || [])
    .filter((group) => !group.is_income)
    .flatMap((group) => (group.categories || []).filter((category) => !category.is_income))
    .map((category) => ({
      name: String(category.name ?? ''),
      budgeted: Number(category.budgeted) || 0,
      spent: -(Number(category.spent) || 0),
      balance: Number(category.balance) || 0,
    }));
  const overspent = categories.filter((category) => category.balance < 0).sort((a, b) => a.balance - b.balance);
  return {
    budgeted: categories.reduce((sum, category) => sum + category.budgeted, 0),
    spent: categories.reduce((sum, category) => sum + category.spent, 0),
    topCategories: categories.filter((category) => category.spent > 0).sort((a, b) => b.spent - a.spent).slice(0, TOP_CATEGORIES)
      .map(({ name, spent }) => ({ name, spent })),
    overspent: overspent.slice(0, MAX_OVERSPENT).map(({ name, balance }) => ({ name, balance })),
    overspentCount: overspent.length,
  };
}

export function createSummary({ actual, today = currentLocalDate }) {
  return {
    /** Answers a month summary for the chat's account (and the budget of that month). Read-only. */
    async answer({ accountId, connection, request }) {
      let range;
      try {
        range = summaryRange(request, today());
      } catch (error) {
        if (error.code === 'INVALID_COMMAND') return textAnswer(error.message.replace('da busca', 'do resumo'));
        throw error;
      }
      const outcome = await actual.run(connection, async (api) => {
        await api.sync();
        const [accounts, categories, payees] = await Promise.all([api.getAccounts(), api.getCategories(), api.getPayees()]);
        const account = requireChatAccount(accounts, accountId);
        const totals = await accountTotals(api, { accountId: account.id, from: range.from, to: range.to });
        let budget = null;
        try {
          budget = budgetOverview(await api.getBudgetMonth(range.month));
        } catch {
          // A month outside the budget (before it was created): the account part is still answered.
        }
        const payeeNames = new Map(payees.map((payee) => [payee.id, payee.name]));
        const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
        return {
          account,
          totals,
          budget,
          topExpenses: totals.top.map((row) => ({
            date: row.date,
            amount: row.amount,
            payee: payeeNames.get(row.payee) ?? null,
            category: row.is_parent ? 'Dividida em categorias' : (categoryNames.get(row.category) ?? null),
            notes: row.notes ?? null,
          })),
        };
      });
      const { totals } = outcome;
      const view = {
        month: range.month,
        from: range.from,
        to: range.to,
        account: outcome.account.name,
        expenses: totals.expenses,
        expenseCount: totals.expenseCount,
        incomes: totals.incomes,
        incomeCount: totals.incomeCount,
        net: totals.incomes - totals.expenses,
        topExpenses: outcome.topExpenses,
        budget: outcome.budget,
      };
      return { ok: true, kind: 'summary', message: monthSummaryText(view), summary: view };
    },
  };
}
