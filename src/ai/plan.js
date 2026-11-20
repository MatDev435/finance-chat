/**
 * Normalizes the plan returned by the model into the operations the backend
 * understands. Structured Outputs guarantees the JSON shape, but the content
 * is still untrusted: every field is re-checked here (types, enums, sizes,
 * amounts) and anything unexpected rejects the whole plan. Nothing in this
 * module touches the budget; it only produces data for the dispatcher.
 */
import { MAX_SPLITS, parseAmount } from '../parser.js';
import { INTENTS, MAX_OPERATIONS, SEARCH_ORDERS, SEARCH_PERIODS, SEARCH_RESULTS, SUMMARY_PERIODS } from './plan-schema.js';

export const PLAN_ERROR_MESSAGE = 'A IA devolveu uma interpretação que o Finance Chat não conseguiu validar. Nada foi registrado. Tente escrever de outro jeito.';

export function planError(reason) {
  const error = new Error(PLAN_ERROR_MESSAGE);
  error.code = 'AI_INVALID_PLAN';
  error.reason = reason;
  return error;
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Trimmed single-line text, at most `max` characters, or null when empty. */
export function cleanText(value, max) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw planError('text');
  const clean = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return clean || null;
}

function capitalized(value) {
  return value ? value.charAt(0).toLocaleUpperCase('pt-BR') + value.slice(1) : value;
}

/** "45.00" → 45. null stays null. Anything that is not a positive amount rejects the plan. */
function amountFrom(value) {
  const raw = cleanText(value, 32);
  if (raw === null) return null;
  try {
    const amount = parseAmount(raw);
    if (amount > 999_999_999.99) throw planError('amount-range');
    return amount;
  } catch (error) {
    if (error.code === 'AI_INVALID_PLAN') throw error;
    throw planError('amount');
  }
}

function intFrom(value, min, max) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < min || value > max) throw planError('integer');
  return value;
}

function enumFrom(value, allowed) {
  if (value === null || value === undefined) return null;
  if (!allowed.includes(value)) throw planError('enum');
  return value;
}

function whenFrom(date) {
  if (date === null || date === undefined) return null;
  if (!isObject(date)) throw planError('date');
  const daysAgo = intFrom(date.daysAgo, 0, 366);
  const day = intFrom(date.day, 1, 31);
  const month = intFrom(date.month, 1, 12);
  const year = intFrom(date.year, 2000, 2100);
  if (daysAgo !== null) return { daysAgo };
  if (day !== null) return { day, month, year };
  if (month !== null || year !== null) {
    const error = new Error('Informe também o dia da movimentação, por exemplo “dia 12/10”.');
    error.code = 'INVALID_COMMAND';
    throw error;
  }
  return null;
}

function transactionFrom(raw) {
  if (!isObject(raw)) throw planError('transaction');
  const type = enumFrom(raw.type, ['expense', 'income']);
  if (!type) throw planError('transaction-type');
  let splits = null;
  if (raw.splits !== null && raw.splits !== undefined) {
    if (!Array.isArray(raw.splits) || raw.splits.length > MAX_SPLITS) throw planError('splits');
    splits = raw.splits.map((part) => {
      if (!isObject(part)) throw planError('split');
      return { amount: amountFrom(part.amount), category: capitalized(cleanText(part.category, 120)) };
    });
    if (splits.length === 0) splits = null;
  }
  const hints = Array.isArray(raw.categoryHints) ? raw.categoryHints.slice(0, 3).map((hint) => cleanText(hint, 60)).filter(Boolean) : [];
  return {
    type,
    amount: amountFrom(raw.amount),
    description: cleanText(raw.payee, 120),
    category: splits ? null : capitalized(cleanText(raw.category, 120)),
    hints,
    splits,
    notes: capitalized(cleanText(raw.notes, 300)),
    when: whenFrom(raw.date),
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoFrom(value) {
  const raw = cleanText(value, 10);
  if (raw === null) return null;
  if (!ISO_DATE.test(raw)) throw planError('search-date');
  return raw;
}

function searchFrom(raw) {
  if (!isObject(raw)) throw planError('search');
  if (typeof raw.followUp !== 'boolean') throw planError('search-follow-up');
  return {
    followUp: raw.followUp,
    payee: cleanText(raw.payee, 120),
    notes: cleanText(raw.notes, 120),
    category: cleanText(raw.category, 120),
    type: enumFrom(raw.type, ['expense', 'income', 'any']),
    period: enumFrom(raw.period, SEARCH_PERIODS),
    periodCount: intFrom(raw.periodCount, 1, 120),
    month: intFrom(raw.month, 1, 12),
    year: intFrom(raw.year, 2000, 2100),
    from: isoFrom(raw.from),
    to: isoFrom(raw.to),
    minAmount: amountFrom(raw.minAmount),
    maxAmount: amountFrom(raw.maxAmount),
    result: enumFrom(raw.result, SEARCH_RESULTS),
    order: enumFrom(raw.order, SEARCH_ORDERS),
    limit: intFrom(raw.limit, 1, 20),
  };
}

function summaryFrom(raw) {
  if (!isObject(raw)) throw planError('summary');
  const period = enumFrom(raw.period, SUMMARY_PERIODS);
  if (!period) throw planError('summary-period');
  return { period, month: intFrom(raw.month, 1, 12), year: intFrom(raw.year, 2000, 2100) };
}

function operationFrom(raw) {
  if (!isObject(raw)) throw planError('operation');
  const intent = enumFrom(raw.intent, INTENTS);
  switch (intent) {
    case 'create_transaction':
      return { kind: 'transaction', item: transactionFrom(raw.transaction) };
    case 'category_balance':
      return { kind: 'category-available', category: capitalized(cleanText(raw.category, 120)) };
    case 'simulate_spend':
      return { kind: 'category-can-spend', category: capitalized(cleanText(raw.category, 120)), amount: amountFrom(raw.amount) };
    case 'search_transactions':
      return { kind: 'search', search: searchFrom(raw.search) };
    case 'month_summary':
      return { kind: 'summary', summary: summaryFrom(raw.summary) };
    case 'undo':
      return { kind: 'undo' };
    case 'unsupported':
      return { kind: 'unsupported' };
    default:
      throw planError('intent');
  }
}

function draftUpdateFrom(raw) {
  if (!isObject(raw)) throw planError('draft-update');
  const item = intFrom(raw.item, 1, MAX_OPERATIONS);
  if (item === null) throw planError('draft-update-item');
  const field = enumFrom(raw.field, ['amount', 'category']);
  if (!field) throw planError('draft-update-field');
  const part = intFrom(raw.part, 1, MAX_SPLITS);
  if (field === 'amount') {
    const amount = amountFrom(raw.value);
    if (amount === null) throw planError('draft-update-value');
    return { item, part, field, value: amount };
  }
  const value = capitalized(cleanText(raw.value, 120));
  if (!value) throw planError('draft-update-value');
  return { item, part, field, value };
}

/** Validates the raw plan; throws AI_INVALID_PLAN (or INVALID_COMMAND with a user message). */
export function normalizePlan(raw) {
  if (!isObject(raw)) throw planError('root');
  if (!Array.isArray(raw.operations) || raw.operations.length > MAX_OPERATIONS) throw planError('operations');
  if (!Array.isArray(raw.draftUpdates) || raw.draftUpdates.length > 20) throw planError('draft-updates');
  if (typeof raw.cancelDraft !== 'boolean') throw planError('cancel-draft');
  return {
    operations: raw.operations.map(operationFrom),
    draftUpdates: raw.draftUpdates.map(draftUpdateFrom),
    cancelDraft: raw.cancelDraft,
    question: cleanText(raw.question, 300),
  };
}
