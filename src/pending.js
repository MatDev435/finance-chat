let pending = null;
let confirming = false;

export function setPending(preview) {
  pending = preview;
  return pending;
}

export function cancelPending() {
  const existed = pending !== null;
  pending = null;
  return existed;
}

export function getPending() {
  return pending;
}

export async function confirmPending(createTransaction) {
  if (confirming) {
    const error = new Error('Já existe uma confirmação em andamento.');
    error.code = 'CONFIRMATION_IN_PROGRESS';
    throw error;
  }
  if (!pending) {
    const error = new Error('Não há nenhuma movimentação pendente para confirmar.');
    error.code = 'NO_PENDING_TRANSACTION';
    throw error;
  }

  confirming = true;
  const transaction = pending;
  pending = null;
  try {
    return { transaction, result: await createTransaction(transaction) };
  } finally {
    confirming = false;
  }
}
