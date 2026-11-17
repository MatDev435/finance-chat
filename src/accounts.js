/**
 * Chats map 1:1 to Actual accounts, identified only by the account `id`
 * (a stable UUID). Names are display data and may change at any time.
 * Closed accounts and off-budget accounts (which do not use categories)
 * cannot receive transactions from the chat.
 */
export function isChatAccount(account) {
  return Boolean(account) && !account.closed && !account.offbudget;
}

export function chatAccounts(accounts) {
  return accounts.filter(isChatAccount).map(({ id, name }) => ({ id, name }));
}

function accountError(message, reason) {
  const error = new Error(message);
  error.code = 'ACCOUNT_UNAVAILABLE';
  error.reason = reason;
  return error;
}

/** Returns the account with exactly this id, or throws. Never falls back to another account. */
export function requireChatAccount(accounts, accountId) {
  const account = typeof accountId === 'string' && accountId ? accounts.find((item) => item.id === accountId) : undefined;
  if (!account) throw accountError('Esta conta não existe mais no Actual Budget. Atualize a lista de contas.', 'missing');
  if (account.closed) throw accountError(`A conta '${account.name}' está fechada no Actual Budget.`, 'closed');
  if (account.offbudget) throw accountError(`A conta '${account.name}' está fora do orçamento e não usa categorias.`, 'offbudget');
  return { id: account.id, name: account.name };
}
