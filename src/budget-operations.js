import { chatAccounts, requireChatAccount } from './accounts.js';
import { toActualImport, transactionCategoryIds } from './transaction-mapping.js';
import { validateCommand, validationError } from './validation.js';

/**
 * Operations on an already-open budget. They receive the Actual API object and
 * must only be called through the Actual manager, which guarantees that the
 * budget of the right user is the one loaded.
 */

/** Syncs with the server first, so renamed, new, closed or deleted accounts are reflected. */
export async function listChatAccounts(api) {
  await api.sync();
  return chatAccounts(await api.getAccounts());
}

/** Read-only: validates the command for the selected account and maps it. Writes nothing. */
export async function prepareTransaction(api, { accountId, command, date, categoryId }) {
  await api.sync();
  const [accounts, categories] = await Promise.all([api.getAccounts(), api.getCategories()]);
  const validation = validateCommand(command, { accounts, categories, accountId, categoryId });
  return { validation, mapped: toActualImport(validation, date) };
}

/**
 * Writes one confirmed transaction. Account and category are re-validated
 * against freshly synced data right before writing; any failure before the
 * write means nothing was recorded. A failure of the write itself is reported
 * as uncertain so the user checks Actual before sending again.
 *
 * addTransactions() does not return the new id, so the id is found by
 * comparing the account's transactions of that date before and after the
 * write. Nothing else can write in between: the Actual manager runs one
 * operation at a time and there is no sync between the two reads.
 */
export async function commitTransaction(api, mapped) {
  await api.sync();
  const [accounts, categories] = await Promise.all([api.getAccounts(), api.getCategories()]);
  const account = requireChatAccount(accounts, mapped.accountId);
  const known = new Set(categories.map((category) => category.id));
  if (!transactionCategoryIds(mapped.transaction).every((id) => known.has(id))) {
    throw validationError('A categoria desta movimentação não existe mais no Actual Budget. Envie a mensagem novamente.');
  }
  const { date } = mapped.transaction;
  const before = new Set((await api.getTransactions(account.id, date, date)).map((transaction) => transaction.id));

  try {
    await api.addTransactions(account.id, [mapped.transaction]);
  } catch (cause) {
    const error = new Error('Não foi possível confirmar se a movimentação foi registrada. Verifique no Actual Budget antes de enviar novamente.');
    error.code = 'WRITE_UNCERTAIN';
    error.cause = cause;
    throw error;
  }

  let transactionId = null;
  try {
    const created = (await api.getTransactions(account.id, date, date)).filter((transaction) => !before.has(transaction.id));
    if (created.length === 1) transactionId = created[0].id;
  } catch {
    // The write succeeded; without the id, undo is simply not offered.
  }

  try {
    await api.sync();
    return { account, synced: true, transactionId };
  } catch {
    // The transaction is stored in the local copy and is uploaded on the next successful sync.
    return { account, synced: false, transactionId };
  }
}

function undoError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Deletes a transaction this app has just created, only if it is still
 * exactly where and as it was written (same account, date and amount).
 * Anything else is refused: the app never deletes a transaction the user
 * changed in Actual in the meantime.
 */
export async function undoTransaction(api, { accountId, transactionId, date, amount }) {
  await api.sync();
  const found = (await api.getTransactions(accountId, date, date)).find((transaction) => transaction.id === transactionId);
  if (!found) {
    throw undoError('UNDO_NOT_FOUND', 'A movimentação não foi encontrada como foi registrada: ela pode ter sido apagada ou alterada no Actual Budget. Nada foi desfeito.');
  }
  if (found.amount !== amount) {
    throw undoError('UNDO_CHANGED', 'A movimentação foi alterada no Actual Budget depois de registrada. Para não apagar algo diferente, nada foi desfeito.');
  }

  try {
    await api.deleteTransaction(transactionId);
  } catch (cause) {
    const error = undoError('UNDO_UNCERTAIN', 'Não foi possível confirmar se a movimentação foi desfeita. Verifique no Actual Budget.');
    error.cause = cause;
    throw error;
  }

  try {
    await api.sync();
    return { synced: true };
  } catch {
    return { synced: false };
  }
}
