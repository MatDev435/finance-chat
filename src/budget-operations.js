import { chatAccounts, requireChatAccount } from './accounts.js';
import { resolveDate } from './dates.js';
import { applyUpdates, checkItems, missingFields, pickerCategories, resolveItems, toCommand } from './drafts.js';
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

/**
 * Read-only: resolves AI draft items (and optional updates filling missing
 * data) against freshly synced budget data. While something is missing it
 * returns { status: 'incomplete', items, missing, categories }; once complete
 * every item goes through the same validation and mapping as a parsed
 * command and it returns { status: 'ready', previews: [{ command, validation, mapped, date }] }.
 * Writes nothing.
 */
export async function prepareItems(api, { accountId, items, updates = [], today }) {
  await api.sync();
  const [accounts, categories] = await Promise.all([api.getAccounts(), api.getCategories()]);
  const account = requireChatAccount(accounts, accountId);
  let current = resolveItems(items, categories);
  let applied = 0;
  if (updates.length) ({ items: current, applied } = applyUpdates(current, updates, categories));
  checkItems(current);
  const missing = missingFields(current);
  if (missing.length) return { status: 'incomplete', account, items: current, missing, applied, categories: pickerCategories(categories) };
  const previews = current.map((item) => {
    const command = toCommand(item);
    const validation = validateCommand(command, { accounts, categories, accountId });
    const date = resolveDate(command.when, today);
    return { command, validation, mapped: toActualImport(validation, date), date };
  });
  return { status: 'ready', account, items: current, previews, applied };
}

/**
 * Ids of the transactions a complete batch created, in the batch order, or
 * null when they cannot be told apart with certainty. Each written item is
 * paired with a new transaction of the same date and amount (identical items
 * are interchangeable); any leftover or missing transaction means null.
 */
export function pairCreated(mappedList, created) {
  const unused = [...created];
  const ids = [];
  for (const { transaction } of mappedList) {
    const index = unused.findIndex((item) => item.date === transaction.date && item.amount === transaction.amount);
    if (index === -1) return null;
    ids.push(unused[index].id);
    unused.splice(index, 1);
  }
  return unused.length ? null : ids;
}

/**
 * Writes a confirmed batch, one transaction at a time, in order. Account and
 * every category are re-validated first: any problem there means nothing is
 * written. During the writes, the first failure stops the batch: that item is
 * "uncertain" (it may or may not have been recorded) and the following ones
 * are "skipped" (never sent). Nothing is retried automatically. Returns
 * { account, results: ['written' | 'uncertain' | 'skipped'], synced, transactionIds }.
 *
 * transactionIds (for undoing the whole batch) is only set when every item was
 * written and the new ids were identified, like commitTransaction does: the
 * account's transactions in the batch's date range are compared before and
 * after the writes (one operation at a time, no sync in between).
 */
export async function commitTransactions(api, mappedList) {
  await api.sync();
  const [accounts, categories] = await Promise.all([api.getAccounts(), api.getCategories()]);
  const accountId = mappedList[0]?.accountId;
  const account = requireChatAccount(accounts, accountId);
  if (mappedList.some((mapped) => mapped.accountId !== accountId)) throw validationError('As movimentações deste lote não são todas da mesma conta. Envie a mensagem novamente.');
  const known = new Set(categories.map((category) => category.id));
  if (!mappedList.every((mapped) => transactionCategoryIds(mapped.transaction).every((id) => known.has(id)))) {
    throw validationError('Uma das categorias deste lote não existe mais no Actual Budget. Envie a mensagem novamente.');
  }

  const dates = mappedList.map((mapped) => mapped.transaction.date).sort();
  const [first, last] = [dates[0], dates.at(-1)];
  let before = null;
  try {
    before = new Set((await api.getTransactions(account.id, first, last)).map((transaction) => transaction.id));
  } catch {
    // Without the snapshot the batch is still written; it just cannot be undone.
  }

  const results = mappedList.map(() => 'skipped');
  for (let index = 0; index < mappedList.length; index += 1) {
    try {
      await api.addTransactions(account.id, [mappedList[index].transaction]);
      results[index] = 'written';
    } catch {
      results[index] = 'uncertain';
      break;
    }
  }

  let transactionIds = null;
  if (before && results.every((result) => result === 'written')) {
    try {
      const created = (await api.getTransactions(account.id, first, last)).filter((transaction) => !before.has(transaction.id));
      transactionIds = pairCreated(mappedList, created);
    } catch {
      // The writes succeeded; without the ids, undo is simply not offered.
    }
  }

  try {
    await api.sync();
    return { account, results, synced: true, transactionIds };
  } catch {
    // What was written stays in the local copy and is uploaded on the next successful sync.
    return { account, results, synced: false, transactionIds };
  }
}

function undoError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Deletes a whole batch this app has just created. Every transaction is
 * checked first (same account, date and amount as written): if any of them
 * was deleted or changed in Actual, nothing is deleted. Then they are deleted
 * one by one; a failure in the middle is reported as uncertain, with how many
 * were already deleted.
 */
export async function undoTransactions(api, { accountId, transactions }) {
  await api.sync();
  for (const item of transactions) {
    const found = (await api.getTransactions(accountId, item.date, item.date)).find((transaction) => transaction.id === item.transactionId);
    if (!found) {
      throw undoError('UNDO_NOT_FOUND', 'Uma das movimentações do lote não foi encontrada como foi registrada: ela pode ter sido apagada ou alterada no Actual Budget. Nada foi desfeito.');
    }
    if (found.amount !== item.amount) {
      throw undoError('UNDO_CHANGED', 'Uma das movimentações do lote foi alterada no Actual Budget depois de registrada. Para não apagar algo diferente, nada foi desfeito.');
    }
  }

  let deleted = 0;
  for (const item of transactions) {
    try {
      await api.deleteTransaction(item.transactionId);
      deleted += 1;
    } catch (cause) {
      const error = undoError('UNDO_UNCERTAIN', deleted
        ? `O lote foi desfeito só em parte: ${deleted} de ${transactions.length} movimentações foram apagadas antes de uma falha. Verifique no Actual Budget.`
        : 'Não foi possível confirmar se as movimentações do lote foram desfeitas. Verifique no Actual Budget.');
      error.cause = cause;
      throw error;
    }
  }

  try {
    await api.sync();
    return { synced: true };
  } catch {
    return { synced: false };
  }
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
