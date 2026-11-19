/**
 * In-memory stand-in for @actual-app/api. Like the real API it is a singleton:
 * init() selects one server and downloadBudget() opens one budget, replacing
 * whatever was open before. Every async method yields to the event loop with
 * a small random delay so that missing serialization shows up as mixed contexts.
 */
function apiError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

export function createBudget({ accounts = [], categories = [], months = {}, payees = [], encryptionPassword = null } = {}) {
  return { accounts, categories, months, payees, encryptionPassword, transactions: [] };
}

/*
 * Minimal AQL for the transaction searches (src/search.js), mirroring what
 * test/search-aql.test.js verifies on the real engine: split parents/parts
 * per the "splits" option, and only the first operator of each condition
 * object is applied (like the real compiler).
 */
function createQuery(table, state = { filters: [], options: {}, select: null, calculate: null, orderBy: [], limit: null }) {
  const next = (patch) => createQuery(table, { ...state, ...patch });
  return {
    table,
    state,
    filter: (expression) => next({ filters: [...state.filters, expression] }),
    options: (options) => next({ options: { ...state.options, ...options } }),
    select: (fields) => next({ select: fields }),
    calculate: (expression) => next({ calculate: expression }),
    orderBy: (expressions) => next({ orderBy: [...state.orderBy, ...[].concat(expressions)] }),
    limit: (limit) => next({ limit }),
  };
}

function transactionRows(budget) {
  const rows = [];
  for (const t of budget.transactions) {
    const base = {
      id: t.id, account: t.account, date: t.date, amount: t.amount, payee: t.payee ?? null, category: t.category ?? null,
      notes: t.notes ?? null, transfer_id: t.transfer_id ?? null, starting_balance_flag: Boolean(t.starting_balance_flag),
      is_parent: false, is_child: false, parent_id: null,
    };
    if (t.subtransactions?.length) {
      rows.push({ ...base, category: null, is_parent: true });
      t.subtransactions.forEach((part, index) => rows.push({ ...base, id: `${t.id}/${index}`, amount: part.amount, category: part.category ?? null, is_child: true, parent_id: t.id }));
    } else {
      rows.push(base);
    }
  }
  return rows;
}

function matchCondition(value, condition) {
  if (Array.isArray(condition)) return condition.every((item) => matchCondition(value, item));
  if (condition === null || typeof condition !== 'object') return condition === null ? value == null : value === condition;
  const [operator] = Object.keys(condition);
  const rhs = condition[operator];
  switch (operator) {
    case '$eq': return rhs === null ? value == null : value === rhs;
    case '$ne': return rhs === null ? value != null : value !== rhs;
    case '$lt': return value < rhs;
    case '$lte': return value <= rhs;
    case '$gt': return value > rhs;
    case '$gte': return value >= rhs;
    case '$oneof': return rhs.includes(value);
    default: throw new Error(`fake AQL: unsupported operator ${operator}`);
  }
}

function matchFilter(row, filter) {
  return Object.entries(filter).every(([field, condition]) => {
    if (field === '$and') return condition.every((item) => matchFilter(row, item));
    if (field === '$or') return condition.some((item) => matchFilter(row, item));
    return matchCondition(row[field], condition);
  });
}

function sortKey(row, expression) {
  if (typeof expression === 'string') return [row[expression], 'asc'];
  if (expression.$abs) return [Math.abs(row[expression.$abs.slice(1)]), expression.$dir || 'asc'];
  const [[field, dir]] = Object.entries(expression);
  return [row[field], dir];
}

function runQuery(budget, query) {
  const { state } = query;
  if (query.table !== 'transactions') throw new Error(`fake AQL: unsupported table ${query.table}`);
  const splits = state.options.splits || 'inline';
  let rows = transactionRows(budget).filter((row) => (splits === 'inline' ? !row.is_parent : splits === 'none' ? !row.is_child : true));
  rows = rows.filter((row) => state.filters.every((filter) => matchFilter(row, filter)));
  if (state.calculate) {
    if (state.calculate.$sum === '$amount') return { data: rows.reduce((sum, row) => sum + row.amount, 0) };
    if (state.calculate.$count === '$id') return { data: rows.length };
    throw new Error('fake AQL: unsupported calculate');
  }
  const order = state.orderBy.length ? state.orderBy : [{ date: 'desc' }];
  rows.sort((a, b) => {
    for (const expression of order) {
      const [x, dir] = sortKey(a, expression);
      const [y] = sortKey(b, expression);
      if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
  if (state.limit !== null) rows = rows.slice(0, state.limit);
  if (state.select) rows = rows.map((row) => Object.fromEntries([...new Set(['id', ...state.select])].map((field) => [field, row[field]])));
  return { data: structuredClone(rows) };
}

export function createFakeActual(servers) {
  const empty = () => ({ serverURL: null, dataDir: null, server: null, budget: null, syncId: null });
  let state = empty();
  const calls = [];
  const hooks = { beforeSync: null, beforeAdd: null, beforeDelete: null };
  let nextId = 1;
  const tick = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 3));

  function openBudget() {
    if (!state.budget) throw apiError('no-budget', 'No budget file is open');
    return state.budget;
  }

  return {
    calls,
    hooks,
    servers,
    get state() { return state; },

    async init({ dataDir, serverURL, password, sessionToken, verbose }) {
      calls.push({ op: 'init', serverURL, dataDir, verbose });
      await tick();
      state = { ...empty(), serverURL, dataDir };
      const server = servers[serverURL];
      if (!server || server.offline) throw apiError('network-failure', 'Authentication failed: network-failure');
      if (sessionToken !== undefined) {
        if (sessionToken !== server.token) throw apiError('token-expired');
      } else if (password !== server.password) {
        throw apiError('invalid-password', 'Authentication failed: invalid-password');
      }
      state.server = server;
    },

    async downloadBudget(syncId, options) {
      calls.push({ op: 'download', syncId });
      await tick();
      if (!state.server) throw apiError('network-failure');
      const budget = state.server.files[syncId];
      if (!budget) throw apiError('budget-not-found');
      if (budget.encryptionPassword) {
        if (!options?.password) throw apiError('missing-key');
        if (options.password !== budget.encryptionPassword) throw apiError('decrypt-failure');
      }
      state.budget = budget;
      state.syncId = syncId;
    },

    async shutdown() {
      calls.push({ op: 'shutdown', syncId: state.syncId });
      await tick();
      state = empty();
    },

    async sync() {
      calls.push({ op: 'sync', syncId: state.syncId });
      await tick();
      openBudget();
      if (state.server.offline) throw apiError('network-failure');
      hooks.beforeSync?.(state);
    },

    async getAccounts() {
      await tick();
      return structuredClone(openBudget().accounts);
    },

    async getCategories() {
      await tick();
      return structuredClone(openBudget().categories);
    },

    async getBudgetMonth(month) {
      await tick();
      return structuredClone(openBudget().months[month] ?? { categoryGroups: [] });
    },

    async addTransactions(accountId, transactions) {
      calls.push({ op: 'add', syncId: state.syncId, accountId });
      await tick();
      const budget = openBudget();
      hooks.beforeAdd?.(state);
      for (const transaction of transactions) {
        // Like Actual: payee_name finds or creates a payee.
        let payee;
        if (transaction.payee_name) {
          payee = budget.payees.find((item) => item.name.toLowerCase() === transaction.payee_name.toLowerCase());
          if (!payee) {
            payee = { id: `payee-${nextId++}`, name: transaction.payee_name };
            budget.payees.push(payee);
          }
        }
        budget.transactions.push({ id: `tx-${nextId++}`, ...structuredClone(transaction), ...(payee ? { payee: payee.id } : {}), account: accountId });
      }
      return 'ok';
    },

    async getPayees() {
      await tick();
      return structuredClone(openBudget().payees);
    },

    q: (table) => createQuery(table),

    async aqlQuery(query) {
      await tick();
      return runQuery(openBudget(), query);
    },

    async getTransactions(accountId, startDate, endDate) {
      await tick();
      return structuredClone(openBudget().transactions.filter((t) => t.account === accountId && t.date >= startDate && t.date <= endDate));
    },

    async deleteTransaction(id) {
      calls.push({ op: 'delete', syncId: state.syncId, id });
      await tick();
      const budget = openBudget();
      hooks.beforeDelete?.(state);
      const removed = budget.transactions.filter((t) => t.id === id);
      budget.transactions = budget.transactions.filter((t) => t.id !== id);
      return removed;
    },
  };
}
