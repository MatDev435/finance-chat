import { amountToCents } from './parser.js';

export function toActualImport(validation, date) {
  const { command, account, category, splits } = validation;
  const sign = command.type === 'expense' ? -1 : 1;

  const transaction = {
    accountId: account.id,
    transaction: {
      date,
      amount: amountToCents(command.amount) * sign,
      // Messages interpreted by the AI may have no payee ("gastei 50 em alimentação").
      ...(command.description ? { payee_name: command.description } : {}),
      // A split transaction has no category of its own: each part carries one.
      ...(splits
        ? { subtransactions: splits.map((split) => ({ amount: amountToCents(split.amount) * sign, category: split.category.id })) }
        : { category: category.id }),
      ...(command.notes ? { notes: command.notes } : {}),
    },
  };

  return transaction;
}

/** Category ids used by a mapped transaction (one, or one per split part). */
export function transactionCategoryIds(transaction) {
  return transaction.subtransactions ? transaction.subtransactions.map((part) => part.category) : [transaction.category];
}

export function currentLocalDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.APP_TIME_ZONE || 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}
