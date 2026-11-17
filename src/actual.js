import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The official @actual-app/api is a process-wide singleton: one server and one
 * open budget at a time. This manager makes it safe for several users:
 *
 * - every operation runs in a single exclusive queue, and the queue is only
 *   released when the operation has really finished;
 * - before an operation, the budget of that user's connection is opened if it
 *   is not the one already loaded (shutdown → init → downloadBudget);
 * - each user has a private cache directory: <dataRoot>/<userId>.
 */

const PUBLIC_MESSAGES = {
  authentication: 'O servidor Actual recusou a senha informada.',
  token: 'O servidor Actual recusou a chave de API (inválida, revogada ou expirada).',
  'budget-not-found': 'Nenhum orçamento com esse Sync ID foi encontrado nesse servidor.',
  'encryption-required': 'Este orçamento usa criptografia de ponta a ponta. Informe a senha de criptografia.',
  encryption: 'A senha de criptografia do orçamento está incorreta.',
  'old-encryption': 'Este orçamento usa um formato de criptografia antigo que a API não suporta. Recrie a chave no Actual.',
  network: 'Não foi possível alcançar o servidor Actual. Verifique o endereço e se o servidor está no ar.',
  version: 'O Finance Chat e o servidor Actual estão em versões incompatíveis.',
  'clock-drift': 'O relógio deste servidor está muito diferente do relógio do servidor Actual.',
  actual: 'Não foi possível consultar o Actual Budget.',
};

const DOMAIN_ERRORS = new Set(['VALIDATION_ERROR', 'ACCOUNT_UNAVAILABLE', 'INVALID_COMMAND', 'CATEGORY_NOT_FOUND']);

function reasonFor(error) {
  const code = error?.code;
  if (code === 'invalid-password' || code === 'unauthorized') return 'authentication';
  if (code === 'token-expired') return 'token';
  if (code === 'budget-not-found') return 'budget-not-found';
  if (code === 'missing-key') return 'encryption-required';
  if (code === 'decrypt-failure') return 'encryption';
  if (code === 'old-key-style') return 'old-encryption';
  if (['out-of-sync-migrations', 'out-of-sync-data', 'invalid-schema'].includes(code)) return 'version';
  if (code === 'clock-drift') return 'clock-drift';
  if (['network', 'network-failure', 'download-failure', 'ECONNREFUSED', 'ENOTFOUND'].includes(code)
    || ['AbortError', 'TimeoutError'].includes(error?.name) || /fetch failed|network/i.test(error?.message || '')) return 'network';
  return 'actual';
}

/** Converts any error from the Actual API into a safe, user-facing error. */
export function toActualError(error) {
  if (error?.code === 'ACTUAL_ERROR') return error;
  const reason = reasonFor(error);
  const result = new Error(PUBLIC_MESSAGES[reason]);
  result.code = 'ACTUAL_ERROR';
  result.reason = reason;
  result.detail = typeof error?.code === 'string' ? error.code : `${error?.name}: ${String(error?.message || '').slice(0, 200)}`;
  return result;
}

/** Identifies a connection configuration. Any change (server, file, credentials) yields a different key. */
export function contextKey(connection) {
  return createHash('sha256')
    .update(JSON.stringify([connection.userId, connection.serverUrl, connection.syncId, connection.authMethod, connection.serverSecret, connection.encryptionPassword || '']))
    .digest('hex');
}

export function createActualManager({ api, dataRoot }) {
  let activeKey = null;
  let tail = Promise.resolve();

  function exclusive(task) {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  }

  async function close() {
    activeKey = null;
    try {
      await api.shutdown();
    } catch {
      // Best effort: the next init starts from a clean state anyway.
    }
  }

  async function open(connection, key) {
    await close();
    if (!Number.isInteger(connection.userId) || connection.userId <= 0) throw new Error('Conexão sem usuário válido.');
    const dataDir = join(dataRoot, String(connection.userId));
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const credentials = connection.authMethod === 'token'
      ? { sessionToken: connection.serverSecret }
      : { password: connection.serverSecret };
    try {
      // verbose: false — in verbose mode the API logs failed request bodies, which may include the password.
      await api.init({ dataDir, serverURL: connection.serverUrl, verbose: false, ...credentials });
      await api.downloadBudget(connection.syncId, connection.encryptionPassword ? { password: connection.encryptionPassword } : undefined);
      activeKey = key;
    } catch (error) {
      await close();
      throw toActualError(error);
    }
  }

  return {
    /**
     * Runs `operation(api)` with this connection's budget open, exclusively.
     * Domain errors (validation, unavailable account) pass through; any other
     * failure closes the budget so the next call reconnects from scratch.
     */
    run(connection, operation) {
      const key = contextKey(connection);
      return exclusive(async () => {
        if (activeKey !== key) await open(connection, key);
        try {
          return await operation(api, key);
        } catch (error) {
          if (DOMAIN_ERRORS.has(error?.code)) throw error;
          await close();
          if (error?.code === 'WRITE_UNCERTAIN') throw error;
          throw toActualError(error);
        }
      });
    },

    /** Opens the budget from scratch with a candidate configuration and lists its accounts. */
    test(connection, operation) {
      const key = contextKey(connection);
      return exclusive(async () => {
        await open(connection, key);
        try {
          return await operation(api, key);
        } catch (error) {
          await close();
          throw DOMAIN_ERRORS.has(error?.code) ? error : toActualError(error);
        }
      });
    },

    shutdown() {
      return exclusive(close);
    },

    get activeKey() {
      return activeKey;
    },
  };
}
