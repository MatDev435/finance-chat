/**
 * In-memory stand-in for @actual-app/api. Like the real API it is a singleton:
 * init() selects one server and downloadBudget() opens one budget, replacing
 * whatever was open before. Every async method yields to the event loop with
 * a small random delay so that missing serialization shows up as mixed contexts.
 */
function apiError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

export function createBudget({ accounts = [], categories = [], months = {}, encryptionPassword = null } = {}) {
  return { accounts, categories, months, encryptionPassword, transactions: [] };
}

export function createFakeActual(servers) {
  const empty = () => ({ serverURL: null, dataDir: null, server: null, budget: null, syncId: null });
  let state = empty();
  const calls = [];
  const hooks = { beforeSync: null, beforeAdd: null };
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
      for (const transaction of transactions) budget.transactions.push({ ...structuredClone(transaction), account: accountId });
      return 'ok';
    },
  };
}
