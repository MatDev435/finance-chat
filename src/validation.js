const FIXED_ACCOUNT_NAME = 'Bradesco';

function normalizeName(value) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
}

function validationError(message) {
  const error = new Error(message);
  error.code = 'VALIDATION_ERROR';
  return error;
}

export function validateCommand(command, { accounts, categories }) {
  const account = accounts.find((item) => normalizeName(item.name) === normalizeName(FIXED_ACCOUNT_NAME));
  if (!account) {
    throw validationError(`A conta '${FIXED_ACCOUNT_NAME}' não existe no Actual Budget.`);
  }

  const category = categories.find((item) => normalizeName(item.name) === normalizeName(command.category));
  if (!category) {
    throw validationError(`A categoria '${command.category}' não existe no Actual Budget.`);
  }

  return {
    valid: true,
    command,
    account: { id: account.id, name: account.name },
    category: { id: category.id, name: category.name },
  };
}

export { FIXED_ACCOUNT_NAME };
