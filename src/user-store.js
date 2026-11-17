const SYNC_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
export const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const MAX_SECRET_LENGTH = 1024;

export function inputError(message, field) {
  const error = new Error(message);
  error.code = 'INVALID_INPUT';
  error.field = field;
  return error;
}

export function normalizeServerUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw inputError('Informe o endereço do servidor Actual.', 'serverUrl');
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw inputError('Endereço inválido. Use o formato https://actual.seudominio.com', 'serverUrl');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw inputError('O endereço precisa começar com https:// ou http://', 'serverUrl');
  if (url.username || url.password) throw inputError('Não inclua usuário ou senha no endereço.', 'serverUrl');
  if (url.search || url.hash) throw inputError('O endereço não deve ter parâmetros (?…) nem âncoras (#…).', 'serverUrl');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function secretInput(value, field) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > MAX_SECRET_LENGTH) throw inputError('Valor inválido.', field);
  return value;
}

/**
 * Validates the connection form. Blank secrets keep the stored ones, but only
 * while the server stays the same: a stored password is never sent to a new
 * address without being typed again.
 */
export function resolveConnectionInput(input, existing) {
  const serverUrl = normalizeServerUrl(input.serverUrl);
  const syncId = typeof input.syncId === 'string' ? input.syncId.trim() : '';
  if (!SYNC_ID_PATTERN.test(syncId)) throw inputError('Sync ID inválido. Copie o valor exibido nas configurações avançadas do Actual.', 'syncId');
  const authMethod = ['password', 'token'].includes(input.authMethod) ? input.authMethod : null;
  if (!authMethod) throw inputError('Escolha como entrar no servidor: senha ou chave de API.', 'authMethod');

  const sameServer = Boolean(existing) && existing.serverUrl === serverUrl;
  let serverSecret = secretInput(input.serverSecret, 'serverSecret');
  if (authMethod === 'token') serverSecret = serverSecret.trim();
  if (!serverSecret) {
    if (sameServer && existing.authMethod === authMethod) serverSecret = existing.serverSecret;
    else throw inputError(authMethod === 'token' ? 'Informe a chave de API.' : 'Informe a senha do servidor Actual.', 'serverSecret');
  }

  let encryptionPassword = null;
  if (input.useEncryption === true) {
    const provided = secretInput(input.encryptionPassword, 'encryptionPassword');
    if (provided) encryptionPassword = provided;
    else if (sameServer && existing.syncId === syncId && existing.encryptionPassword) encryptionPassword = existing.encryptionPassword;
    else throw inputError('Informe a senha de criptografia do orçamento.', 'encryptionPassword');
  }

  return { serverUrl, syncId, authMethod, serverSecret, encryptionPassword };
}

/** Per-user Actual connection (secrets encrypted at rest) and preferences. */
export function createUserStore(db, secretBox, { now = Date.now } = {}) {
  const sql = {
    connection: db.prepare('SELECT * FROM actual_connections WHERE user_id = ?'),
    saveConnection: db.prepare(`
      INSERT INTO actual_connections (user_id, server_url, sync_id, auth_method, server_secret, encryption_password, updated_at)
      VALUES (@userId, @serverUrl, @syncId, @authMethod, @serverSecret, @encryptionPassword, @updatedAt)
      ON CONFLICT(user_id) DO UPDATE SET server_url = excluded.server_url, sync_id = excluded.sync_id,
        auth_method = excluded.auth_method, server_secret = excluded.server_secret,
        encryption_password = excluded.encryption_password, updated_at = excluded.updated_at`),
    settings: db.prepare('SELECT default_account_id FROM user_settings WHERE user_id = ?'),
    saveDefault: db.prepare(`
      INSERT INTO user_settings (user_id, default_account_id, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET default_account_id = excluded.default_account_id, updated_at = excluded.updated_at`),
  };
  const context = (userId, field) => `user:${userId}:${field}`;

  return {
    /** Decrypted connection, or null when not configured. Throws SECRET_UNREADABLE if APP_SECRET changed. */
    getConnection(userId) {
      const row = sql.connection.get(userId);
      if (!row) return null;
      return {
        userId,
        serverUrl: row.server_url,
        syncId: row.sync_id,
        authMethod: row.auth_method,
        serverSecret: secretBox.open(row.server_secret, context(userId, 'server_secret')),
        encryptionPassword: row.encryption_password ? secretBox.open(row.encryption_password, context(userId, 'encryption_password')) : null,
      };
    },

    /** Safe to send to the browser: never includes secrets. */
    connectionSummary(userId) {
      const row = sql.connection.get(userId);
      if (!row) return { configured: false };
      return { configured: true, serverUrl: row.server_url, syncId: row.sync_id, authMethod: row.auth_method, hasEncryptionPassword: Boolean(row.encryption_password) };
    },

    saveConnection(userId, connection) {
      sql.saveConnection.run({
        userId,
        serverUrl: connection.serverUrl,
        syncId: connection.syncId,
        authMethod: connection.authMethod,
        serverSecret: secretBox.seal(connection.serverSecret, context(userId, 'server_secret')),
        encryptionPassword: connection.encryptionPassword ? secretBox.seal(connection.encryptionPassword, context(userId, 'encryption_password')) : null,
        updatedAt: now(),
      });
    },

    getSettings(userId) {
      return { defaultAccountId: sql.settings.get(userId)?.default_account_id ?? null };
    },

    setDefaultAccount(userId, accountId) {
      sql.saveDefault.run(userId, accountId, now());
      return this.getSettings(userId);
    },
  };
}
