import { requireChatAccount } from './accounts.js';

function normalizeName(value) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
}

export function validationError(message) {
  const error = new Error(message);
  error.code = 'VALIDATION_ERROR';
  return error;
}

/**
 * Validates a parsed command against the budget. The account comes from the
 * selected chat (stable account id); the category is matched by name because
 * the user types it in the message.
 */
export function validateCommand(command, { accounts, categories, accountId }) {
  const account = requireChatAccount(accounts, accountId);

  const category = categories.find((item) => normalizeName(item.name) === normalizeName(command.category));
  if (!category) {
    throw validationError(`A categoria '${command.category}' não existe no Actual Budget.`);
  }

  return {
    valid: true,
    command,
    account,
    category: { id: category.id, name: category.name },
  };
}
