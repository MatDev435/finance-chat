import { chatAccounts, requireChatAccount } from './accounts.js';
import { toActualImport } from './transaction-mapping.js';
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
 */
export async function commitTransaction(api, mapped) {
  await api.sync();
  const [accounts, categories] = await Promise.all([api.getAccounts(), api.getCategories()]);
  const account = requireChatAccount(accounts, mapped.accountId);
  if (!categories.some((category) => category.id === mapped.transaction.category)) {
    throw validationError('A categoria desta movimentação não existe mais no Actual Budget. Envie a mensagem novamente.');
  }

  try {
    await api.addTransactions(account.id, [mapped.transaction]);
  } catch (cause) {
    const error = new Error('Não foi possível confirmar se a movimentação foi registrada. Verifique no Actual Budget antes de enviar novamente.');
    error.code = 'WRITE_UNCERTAIN';
    error.cause = cause;
    throw error;
  }

  try {
    await api.sync();
    return { account, synced: true };
  } catch {
    // The transaction is stored in the local copy and is uploaded on the next successful sync.
    return { account, synced: false };
  }
}
