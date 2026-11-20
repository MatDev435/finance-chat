/**
 * Visual-only chat history kept in localStorage: at most HISTORY_LIMIT
 * messages per chat, keyed by user id and Actual account id. It is never sent
 * to the server and never used for financial operations; Actual Budget is
 * the source of truth. Only whitelisted display fields are stored.
 */
export const HISTORY_LIMIT = 10;
const VERSION = 'v1';
const MAX_TEXT = 2000;
const ROLES = new Set(['user', 'assistant']);
const KINDS = new Set(['text', 'error', 'warning', 'preview', 'spending', 'batch', 'clarify', 'search', 'summary']);
const STATUSES = new Set(['pending', 'confirmed', 'cancelled', 'failed', 'undone', 'partial', 'done']);

export function historyPrefix(userId) {
  return `finance-chat:history:${VERSION}:${userId}:`;
}

export function historyKey(userId, accountId) {
  return `${historyPrefix(userId)}${accountId}`;
}

const text = (value, max = MAX_TEXT) => (typeof value === 'string' ? value.slice(0, max) : '');
const number = (value) => (Number.isFinite(value) ? value : null);

const amountOrNull = (value) => (value === null || value === undefined ? null : number(value));

/** One item of a batch or draft: display fields only. */
function sanitizeItem(item) {
  return {
    type: item?.type === 'income' ? 'income' : 'expense',
    amount: amountOrNull(item?.amount),
    description: text(item?.description, 200),
    category: text(item?.category, 200),
    date: text(item?.date, 10),
    ...(Array.isArray(item?.parts) ? { parts: item.parts.slice(0, 10).map((part) => ({ category: text(part?.category, 200), amount: amountOrNull(part?.amount) })) } : {}),
  };
}

function sanitizeData(kind, data) {
  if (!data || typeof data !== 'object') return undefined;
  if (kind === 'batch' || kind === 'clarify') {
    const items = Array.isArray(data.items) ? data.items.slice(0, 10).map(sanitizeItem) : [];
    if (kind === 'clarify') {
      return { items, missing: Array.isArray(data.missing) ? data.missing.slice(0, 20).map((missing) => ({ label: text(missing?.label, 300) })) : [] };
    }
    return { items, expenses: number(data.expenses), incomes: number(data.incomes), account: text(data.account, 200) };
  }
  if (kind === 'search') {
    return {
      result: ['list', 'sum', 'count', 'max', 'min'].includes(data.result) ? data.result : 'list',
      type: ['expense', 'income', 'any'].includes(data.type) ? data.type : 'any',
      from: data.from ? text(data.from, 10) : null,
      to: text(data.to, 10),
      account: text(data.account, 200),
      payees: Array.isArray(data.payees) ? data.payees.slice(0, 10).map((payee) => text(payee, 200)) : [],
      category: data.category ? text(data.category, 200) : null,
      notes: data.notes ? text(data.notes, 200) : null,
      count: number(data.count) ?? 0,
      total: number(data.total) ?? 0,
      transactions: Array.isArray(data.transactions) ? data.transactions.slice(0, 20).map((transaction) => ({
        date: text(transaction?.date, 10),
        amount: number(transaction?.amount) ?? 0,
        payee: transaction?.payee ? text(transaction.payee, 200) : null,
        category: transaction?.category ? text(transaction.category, 200) : null,
        ...(transaction?.notes ? { notes: text(transaction.notes, 300) } : {}),
      })) : [],
    };
  }
  if (kind === 'summary') {
    const cents = (value) => number(value) ?? 0;
    const budget = data.budget && typeof data.budget === 'object' ? {
      budgeted: cents(data.budget.budgeted),
      spent: cents(data.budget.spent),
      topCategories: Array.isArray(data.budget.topCategories) ? data.budget.topCategories.slice(0, 3).map((category) => ({ name: text(category?.name, 200), spent: cents(category?.spent) })) : [],
      overspent: Array.isArray(data.budget.overspent) ? data.budget.overspent.slice(0, 5).map((category) => ({ name: text(category?.name, 200), balance: cents(category?.balance) })) : [],
      overspentCount: cents(data.budget.overspentCount),
    } : null;
    return {
      month: text(data.month, 7),
      from: text(data.from, 10),
      to: text(data.to, 10),
      account: text(data.account, 200),
      expenses: cents(data.expenses),
      expenseCount: cents(data.expenseCount),
      incomes: cents(data.incomes),
      incomeCount: cents(data.incomeCount),
      net: cents(data.net),
      topExpenses: Array.isArray(data.topExpenses) ? data.topExpenses.slice(0, 3).map((expense) => ({
        date: text(expense?.date, 10),
        amount: cents(expense?.amount),
        payee: expense?.payee ? text(expense.payee, 200) : null,
        category: expense?.category ? text(expense.category, 200) : null,
      })) : [],
      budget,
    };
  }
  if (kind === 'preview') {
    return {
      type: data.type === 'income' ? 'income' : 'expense',
      amount: number(data.amount),
      description: text(data.description, 200),
      category: text(data.category, 200),
      account: text(data.account, 200),
      date: text(data.date, 10),
      ...(data.notes ? { notes: text(data.notes, 500) } : {}),
      ...(Array.isArray(data.parts) ? { parts: data.parts.slice(0, 10).map((part) => ({ category: text(part?.category, 200), amount: number(part?.amount) })) } : {}),
    };
  }
  if (kind === 'spending') {
    return {
      category: text(data.category, 200),
      available: number(data.available),
      requested: number(data.requested),
      remaining: number(data.remaining),
      canSpend: Boolean(data.canSpend),
    };
  }
  return undefined;
}

/** Returns a storable copy of an entry with only known fields, or null if it is not valid. */
export function sanitizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || !ROLES.has(entry.role) || !KINDS.has(entry.kind)) return null;
  const clean = {
    id: text(entry.id, 64) || `m${Date.now().toString(36)}`,
    role: entry.role,
    kind: entry.kind,
    text: text(entry.text),
    at: Number.isFinite(entry.at) ? entry.at : Date.now(),
  };
  const data = sanitizeData(entry.kind, entry.data);
  if (data) clean.data = data;
  if (STATUSES.has(entry.status)) clean.status = entry.status;
  if (entry.ai === true) clean.ai = true;
  return clean;
}

export function createHistory(storage, userId, { limit = HISTORY_LIMIT } = {}) {
  const prefix = historyPrefix(userId);
  const memory = new Map();

  function read(accountId) {
    const key = prefix + accountId;
    if (!storage) return memory.get(key) || [];
    try {
      const parsed = JSON.parse(storage.getItem(key) || '[]');
      return Array.isArray(parsed) ? parsed.map(sanitizeEntry).filter(Boolean).slice(-limit) : [];
    } catch {
      return [];
    }
  }

  function write(accountId, entries) {
    const key = prefix + accountId;
    const trimmed = entries.slice(-limit);
    if (!storage) {
      memory.set(key, trimmed);
      return trimmed;
    }
    try {
      storage.setItem(key, JSON.stringify(trimmed));
    } catch {
      // Storage full or blocked: history is a convenience, the chat keeps working.
    }
    return trimmed;
  }

  return {
    load: read,

    append(accountId, entry) {
      const clean = sanitizeEntry(entry);
      if (!clean) return read(accountId);
      return write(accountId, [...read(accountId), clean]);
    },

    update(accountId, entryId, patch) {
      return write(accountId, read(accountId).map((entry) => (entry.id === entryId ? sanitizeEntry({ ...entry, ...patch, id: entry.id }) || entry : entry)));
    },

    last(accountId) {
      return read(accountId).at(-1) || null;
    },

    /** Removes every chat history of this user from this browser. */
    clear() {
      memory.clear();
      if (!storage) return;
      try {
        const keys = [];
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key?.startsWith(prefix)) keys.push(key);
        }
        keys.forEach((key) => storage.removeItem(key));
      } catch {
        // Ignore storage errors.
      }
    },
  };
}

/** localStorage when usable, otherwise null (private mode, disabled storage). */
export function browserStorage() {
  try {
    const storage = globalThis.localStorage;
    const probe = '__finance_chat_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}
