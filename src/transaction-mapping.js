import { amountToCents } from './parser.js';

export function toActualImport(validation, date) {
  const { command, account, category } = validation;
  const signedAmount = amountToCents(command.amount) * (command.type === 'expense' ? -1 : 1);

  const transaction = {
    accountId: account.id,
    transaction: {
      date,
      amount: signedAmount,
      payee_name: command.description,
      category: category.id,
      ...(command.notes ? { notes: command.notes } : {}),
    },
  };

  return transaction;
}

export function currentLocalDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.APP_TIME_ZONE || 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}
