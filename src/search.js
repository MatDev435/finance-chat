/**
 * Transaction search over the chat's account, with the Actual API's AQL
 * (q() + aqlQuery(), executed in SQL on the local copy of the budget).
 *
 * The model never writes AQL: it fills a small, validated request (plan.js),
 * and this module builds the query from it. Rules verified against
 * @actual-app/api 26.11 (see test/search-aql.test.js, which runs the real
 * engine offline with fictitious data):
 *
 * - The account is always the chat's account, whatever the request says.
 * - Transfers (transfer_id set) and the starting balance are excluded.
 * - Splits: with a category filter, `splits: 'inline'` (the parts, which carry
 *   the categories; the parent is left out); otherwise `splits: 'none'` (whole
 *   purchases; the parts, which repeat the payee, are left out). Either way
 *   a split purchase is counted once.
 * - Each AQL condition object applies only its first operator, so ranges are
 *   written as arrays of single-operator conditions.
 * - $oneof interpolates its values into SQL, so it only ever receives payee
 *   ids read from the budget (and checked), never text from the request.
 * - Notes are matched with $like, which the engine runs as a case-insensitive
 *   pattern against the notes without accents (UNICODE_LIKE + NORMALISE). The
 *   term is folded the same way and its wildcards (%, ?, \) are escaped, so
 *   it is always a plain "contains". In a category search (split parts), the
 *   note of the whole purchase also counts: the ids of the split purchases
 *   whose note matches are read first (the engine cannot join a part to its
 *   parent), then their parts are included by parent_id.
 */
import { requireChatAccount } from './accounts.js';
import { foldName, levenshtein, matchCategory, notFoundMessage } from './category-match.js';
import { searchText } from './chat-text.js';
import { resolvePeriod } from './periods.js';
import { amountToCents } from './parser.js';
import { currentLocalDate } from './transaction-mapping.js';

export const DEFAULT_LIST_LIMIT = 5;
export const MAX_LIST_LIMIT = 20;
const MAX_PAYEES = 10;
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const FIELDS = ['id', 'date', 'amount', 'payee', 'category', 'notes', 'is_parent'];
const FILTER_KEYS = ['payee', 'notes', 'category', 'type', 'minAmount', 'maxAmount'];
const PERIOD_KEYS = ['period', 'periodCount', 'month', 'year', 'from', 'to'];

const textAnswer = (message) => ({ ok: true, kind: 'text', message });

/** "McDonald's", "mc donalds", "MCDONALDS" → "mcdonalds". */
const squash = (value) => foldName(value).replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Payees that a search term refers to, best evidence first: same letters
 * (ignoring case, accents, spaces and punctuation), then names containing
 * the term, then close spellings. Transfer payees are never matched.
 */
export function matchPayees(payees, term) {
  const target = squash(term || '');
  if (!target) return [];
  const candidates = payees.filter((payee) => payee?.name && !payee.transfer_acct && ID_PATTERN.test(payee.id));
  const exact = candidates.filter((payee) => squash(payee.name) === target);
  if (exact.length) return exact;
  if (target.length >= 3) {
    const containing = candidates.filter((payee) => {
      const name = squash(payee.name);
      return name.includes(target) || (name.length >= 4 && target.includes(name));
    });
    if (containing.length) return containing;
  }
  const threshold = Math.max(1, Math.floor(target.length / 4));
  return candidates.filter((payee) => levenshtein(target, squash(payee.name)) <= threshold);
}

/** "Pão de Açúcar 50%" → "%pao de acucar 50\\%%": a plain contains-pattern for $like (see the header). */
export function notesPattern(term) {
  const folded = foldName(term || '').replace(/\s+/g, ' ').trim();
  if (!folded) return null;
  return `%${folded.replace(/[\\%?]/g, (character) => `\\${character}`)}%`;
}

/** A follow-up ("e no total?") reuses the previous filters, replacing only what the new request sets. */
export function mergeRequest(request, previous) {
  if (!request.followUp || !previous) return { ...request, followUp: false };
  const merged = { ...previous, followUp: false };
  for (const key of FILTER_KEYS) if (request[key] !== null) merged[key] = request[key];
  if (request.period !== null) for (const key of PERIOD_KEYS) merged[key] = request[key];
  if (request.result !== null) {
    merged.result = request.result;
    merged.order = request.order;
    merged.limit = request.limit;
  } else {
    if (request.order !== null) merged.order = request.order;
    if (request.limit !== null) merged.limit = request.limit;
  }
  return merged;
}

/** The last search as the model sees it: only the filters that are set. */
export function searchContext(request) {
  const context = {};
  for (const key of [...FILTER_KEYS, ...PERIOD_KEYS, 'result']) {
    const value = request[key];
    if (value === null || value === undefined) continue;
    context[key] = typeof value === 'number' && (key === 'minAmount' || key === 'maxAmount') ? value.toFixed(2) : value;
  }
  return context;
}

/** AQL filter for a resolved search spec. */
export function buildFilter(spec) {
  const filter = { account: spec.accountId, transfer_id: null, starting_balance_flag: false };
  const date = [{ $lte: spec.to }];
  if (spec.from) date.unshift({ $gte: spec.from });
  filter.date = date;
  const min = spec.minCents ?? null;
  const max = spec.maxCents ?? null;
  const signed = (sign) => {
    const conditions = [sign < 0 ? { $lt: 0 } : { $gt: 0 }];
    if (min !== null) conditions.push(sign < 0 ? { $lte: -min } : { $gte: min });
    if (max !== null) conditions.push(sign < 0 ? { $gte: -max } : { $lte: max });
    return conditions;
  };
  if (spec.type === 'expense') filter.amount = signed(-1);
  else if (spec.type === 'income') filter.amount = signed(1);
  else if (min !== null || max !== null) filter.$or = [{ amount: signed(-1) }, { amount: signed(1) }];
  if (spec.payeeIds) filter.payee = { $oneof: spec.payeeIds };
  if (spec.categoryId) filter.category = spec.categoryId;
  if (spec.notesPattern) {
    const notes = { notes: { $like: spec.notesPattern } };
    // A split part rarely has a note of its own: the purchase's note is on the parent.
    const parents = spec.categoryId ? spec.notesParentIds ?? [] : [];
    const condition = parents.length ? { $or: [notes, { parent_id: { $oneof: parents } }] } : notes;
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, condition];
      delete filter.$or;
    } else if (condition.$or) {
      filter.$or = condition.$or;
    } else {
      Object.assign(filter, condition);
    }
  }
  return filter;
}

const ORDERS = {
  newest: [{ date: 'desc' }],
  oldest: [{ date: 'asc' }],
  largest: [{ $abs: '$amount', $dir: 'desc' }, { date: 'desc' }],
  smallest: [{ $abs: '$amount', $dir: 'asc' }, { date: 'desc' }],
};

/** Runs the search on an open budget: { count, total (cents), rows }. Read-only. */
export async function executeSearch(api, spec) {
  if (spec.payeeIds && !spec.payeeIds.every((id) => ID_PATTERN.test(id))) throw new Error('Invalid payee id');
  if (spec.categoryId && spec.notesPattern) {
    const parents = await api.aqlQuery(api.q('transactions')
      .filter({ account: spec.accountId, is_parent: true, notes: { $like: spec.notesPattern } })
      .options({ splits: 'none' })
      .select(['id']));
    const ids = (parents.data || []).map((row) => row.id);
    if (!ids.every((id) => ID_PATTERN.test(id))) throw new Error('Invalid transaction id');
    spec = { ...spec, notesParentIds: ids };
  }
  const base = () => api.q('transactions').filter(buildFilter(spec)).options({ splits: spec.categoryId ? 'inline' : 'none' });
  const scalar = async (expression) => Number((await api.aqlQuery(base().calculate(expression))).data) || 0;
  const count = await scalar({ $count: '$id' });
  const total = count ? await scalar({ $sum: '$amount' }) : 0;
  let rows = [];
  if (count && spec.result !== 'sum' && spec.result !== 'count') {
    const order = spec.result === 'max' ? ORDERS.largest : spec.result === 'min' ? ORDERS.smallest : ORDERS[spec.order] || ORDERS.newest;
    const limit = spec.result === 'list' ? spec.limit : 1;
    rows = (await api.aqlQuery(base().orderBy(order).limit(limit).select(FIELDS))).data || [];
  }
  return { count, total, rows };
}

export function createSearch({ actual, conversations, today = currentLocalDate }) {
  return {
    context: searchContext,

    /** Answers one search request of the AI plan, for the chat's account only. */
    async answer({ userId, accountId, connection, request }) {
      const previous = conversations.getQuery(userId, accountId);
      if (request.followUp && !previous) {
        return textAnswer('Não encontrei uma busca anterior nesta conversa (elas valem por 15 minutos). Pode repetir a pergunta completa?');
      }
      const merged = mergeRequest(request, previous);
      let period;
      try {
        period = resolvePeriod(merged, today());
      } catch (error) {
        if (error.code === 'INVALID_COMMAND') return textAnswer(error.message);
        throw error;
      }
      if (merged.minAmount !== null && merged.maxAmount !== null && merged.minAmount > merged.maxAmount) {
        return textAnswer('O valor mínimo da busca é maior que o máximo.');
      }
      conversations.putQuery(userId, accountId, merged);

      const type = merged.type || 'any';
      const result = merged.result || 'list';
      const outcome = await actual.run(connection, async (api) => {
        await api.sync();
        const [accounts, categories, payees] = await Promise.all([api.getAccounts(), api.getCategories(), api.getPayees()]);
        const account = requireChatAccount(accounts, accountId);
        let category = null;
        if (merged.category) {
          const match = matchCategory(categories, merged.category);
          if (!match.category) return { message: notFoundMessage(merged.category, match.suggestions) };
          category = match.category;
        }
        let matched = null;
        let notesTerm = merged.notes;
        let payeeAsNotes = false;
        if (merged.payee) {
          matched = matchPayees(payees, merged.payee);
          if (!matched.length && !notesTerm) {
            // "quanto gastei com Monster": no such payee, so it may be what was bought (the notes).
            notesTerm = merged.payee;
            payeeAsNotes = true;
            matched = null;
          } else if (!matched.length) {
            return { empty: true, account, category, payeeTerm: merged.payee };
          }
        }
        if (matched && matched.length > MAX_PAYEES) {
          return { message: `Encontrei muitos beneficiários parecidos com “${merged.payee}” (${matched.slice(0, 5).map((payee) => payee.name).join(', ')}…). Pode ser mais específico?` };
        }
        const pattern = notesTerm ? notesPattern(notesTerm) : null;
        const spec = {
          accountId: account.id,
          from: period.from,
          to: period.to,
          type,
          minCents: merged.minAmount === null ? null : amountToCents(merged.minAmount),
          maxCents: merged.maxAmount === null ? null : amountToCents(merged.maxAmount),
          payeeIds: matched ? matched.map((payee) => payee.id) : null,
          categoryId: category?.id ?? null,
          notesPattern: pattern,
          result,
          order: merged.order || 'newest',
          limit: Math.min(merged.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
        };
        const data = await executeSearch(api, spec);
        const payeeNames = new Map(payees.map((payee) => [payee.id, payee.name]));
        const categoryNames = new Map(categories.map((item) => [item.id, item.name]));
        return {
          account,
          category,
          payees: matched ? matched.map((payee) => payee.name) : [],
          notes: pattern ? notesTerm : null,
          payeeAsNotes,
          spec,
          data: {
            ...data,
            transactions: data.rows.map((row) => ({
              date: row.date,
              amount: row.amount,
              payee: payeeNames.get(row.payee) ?? null,
              category: row.is_parent ? 'Dividida em categorias' : (categoryNames.get(row.category) ?? null),
              notes: row.notes ?? null,
            })),
          },
        };
      });

      if (outcome.message) return textAnswer(outcome.message);
      const view = {
        result,
        type,
        order: merged.order || 'newest',
        limit: outcome.spec?.limit ?? null,
        from: period.from,
        to: period.to,
        account: outcome.account.name,
        payees: outcome.empty ? [merged.payee] : outcome.payees,
        notes: outcome.empty ? (merged.notes ?? null) : outcome.notes,
        payeeAsNotes: Boolean(outcome.payeeAsNotes),
        category: outcome.category?.name ?? null,
        minAmount: merged.minAmount,
        maxAmount: merged.maxAmount,
        count: outcome.empty ? 0 : outcome.data.count,
        total: outcome.empty ? 0 : outcome.data.total,
        transactions: outcome.empty ? [] : outcome.data.transactions,
      };
      return { ok: true, kind: 'search', message: searchText(view), search: view };
    },
  };
}
