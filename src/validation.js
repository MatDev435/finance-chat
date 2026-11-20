import { requireChatAccount } from './accounts.js';
import { matchCategory, notFoundMessage } from './category-match.js';

export function validationError(message) {
  const error = new Error(message);
  error.code = 'VALIDATION_ERROR';
  return error;
}

/**
 * Resolves the category typed in the message. `categoryId` is set when the
 * user picked one of the suggestions offered for an unknown category.
 */
export function resolveCategory(categories, requested, categoryId) {
  if (categoryId) {
    const chosen = categories.find((item) => item.id === categoryId);
    if (!chosen) throw validationError('A categoria escolhida não existe mais no Actual Budget. Envie a mensagem novamente.');
    return chosen;
  }
  const { category, suggestions } = matchCategory(categories, requested);
  if (!category) {
    const error = validationError(notFoundMessage(requested, suggestions));
    error.suggestions = suggestions;
    // Lets the hybrid mode tell "the typed category does not exist" apart from other errors.
    error.categoryMiss = true;
    throw error;
  }
  return category;
}

/**
 * Validates a parsed command against the budget. The account comes from the
 * selected chat (stable account id); the category is matched by name because
 * the user types it in the message. A category already resolved to an id
 * (`command.categoryId`, `split.categoryId`: the user picked or confirmed it)
 * is checked by id instead.
 */
export function validateCommand(command, { accounts, categories, accountId, categoryId }) {
  const account = requireChatAccount(accounts, accountId);

  if (command.splits) {
    const splits = command.splits.map((split) => {
      try {
        const category = resolveCategory(categories, split.category, split.categoryId);
        return { amount: split.amount, category: { id: category.id, name: category.name } };
      } catch (error) {
        // Suggestions stay in the message; the one-click choice applies only to single-category messages.
        delete error.suggestions;
        throw error;
      }
    });
    return { valid: true, command, account, category: null, splits };
  }

  const category = resolveCategory(categories, command.category, categoryId ?? command.categoryId);

  return {
    valid: true,
    command,
    account,
    category: { id: category.id, name: category.name },
  };
}
