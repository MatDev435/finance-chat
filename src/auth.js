import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { deriveKey } from './secrets.js';

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REFRESH_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** A refresh token replaced less than this long ago is still accepted once (parallel tabs, lost responses). */
export const REFRESH_REUSE_GRACE_MS = 60 * 1000;

/** OWASP-recommended scrypt profile with a 16 MiB memory cost. */
export const PASSWORD_PARAMS = Object.freeze({ N: 16384, r: 8, p: 5 });
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

function authError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function normalizeUsername(value) {
  const username = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!USERNAME_PATTERN.test(username)) {
    throw authError('INVALID_INPUT', 'O nome de usuário deve ter de 3 a 32 caracteres: letras sem acento, números, ponto, hífen ou sublinhado.');
  }
  return username;
}

export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) {
    throw authError('INVALID_INPUT', `A senha deve ter de ${MIN_PASSWORD_LENGTH} a ${MAX_PASSWORD_LENGTH} caracteres.`);
  }
  return value;
}

function derive(password, salt, { N, r, p }) {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N, r, p, maxmem: 256 * N * r }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password, params = PASSWORD_PARAMS) {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, encoded, params = PASSWORD_PARAMS) {
  const [scheme, N, r, p, salt, expected] = String(encoded).split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return { valid: false, needsRehash: false };
  const stored = { N: Number(N), r: Number(r), p: Number(p) };
  const expectedKey = Buffer.from(expected, 'base64url');
  const key = await derive(password, Buffer.from(salt, 'base64url'), stored);
  const valid = key.length === expectedKey.length && timingSafeEqual(key, expectedKey);
  const needsRehash = stored.N !== params.N || stored.r !== params.r || stored.p !== params.p;
  return { valid, needsRehash };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Compact HMAC-SHA256 signed token: v1.<payload>.<signature>. Holds only ids and expiry. */
export function createAccessTokens(appSecret, { now = Date.now, ttlMs = ACCESS_TOKEN_TTL_MS } = {}) {
  const key = deriveKey(appSecret, 'access-token-v1');
  const signature = (data) => createHmac('sha256', key).update(data).digest();

  return {
    ttlMs,
    sign({ userId, sessionId }) {
      const expiresAt = now() + ttlMs;
      const payload = Buffer.from(JSON.stringify({ u: userId, s: sessionId, e: expiresAt })).toString('base64url');
      return { token: `v1.${payload}.${signature(`v1.${payload}`).toString('base64url')}`, expiresAt };
    },
    verify(token) {
      if (typeof token !== 'string' || token.length > 512) return null;
      const [version, payload, provided] = token.split('.');
      if (version !== 'v1' || !payload || !provided) return null;
      const expected = signature(`v1.${payload}`);
      const actual = Buffer.from(provided, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
      try {
        const { u, s, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!Number.isInteger(u) || typeof s !== 'string' || !Number.isFinite(e) || e <= now()) return null;
        return { userId: u, sessionId: s, expiresAt: e };
      } catch {
        return null;
      }
    },
  };
}

/**
 * Users, sessions and tokens. Refresh tokens are opaque random values stored
 * only as SHA-256 hashes; each refresh rotates them, and presenting a token
 * that was rotated away (outside a short grace window) revokes the session.
 */
export function createAuth({ db, appSecret, now = Date.now, passwordParams = PASSWORD_PARAMS }) {
  const accessTokens = createAccessTokens(appSecret, { now });
  let dummyHash;

  const sql = {
    countUsers: db.prepare('SELECT COUNT(*) FROM users').pluck(),
    insertUser: db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'),
    userByName: db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?'),
    userById: db.prepare('SELECT id, username FROM users WHERE id = ?'),
    updateHash: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (id, user_id, refresh_hash, rotated_at, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'),
    sessionById: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    sessionByRefresh: db.prepare('SELECT * FROM sessions WHERE refresh_hash = ?'),
    sessionByPrevious: db.prepare('SELECT * FROM sessions WHERE previous_refresh_hash = ?'),
    rotate: db.prepare('UPDATE sessions SET refresh_hash = ?, previous_refresh_hash = ?, rotated_at = ?, expires_at = ? WHERE id = ? AND refresh_hash = ?'),
    revoke: db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)'),
  };

  const sessionUsable = (row, time) => row && row.revoked_at === null && row.expires_at > time && row.created_at + SESSION_MAX_AGE_MS > time;
  const nextExpiry = (createdAt, time) => Math.min(time + REFRESH_IDLE_TTL_MS, createdAt + SESSION_MAX_AGE_MS);

  function tokensFor(userId, sessionId, refreshToken, refreshExpiresAt) {
    const access = accessTokens.sign({ userId, sessionId });
    return { accessToken: access.token, accessExpiresAt: access.expiresAt, refreshToken, refreshExpiresAt };
  }

  const createUser = db.transaction((username, passwordHash, allowSignup) => {
    if (!allowSignup && sql.countUsers.get() > 0) throw authError('SIGNUP_DISABLED', 'O cadastro de novos usuários está desativado neste servidor.');
    try {
      return Number(sql.insertUser.run(username, passwordHash, now()).lastInsertRowid);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw authError('USERNAME_TAKEN', 'Esse nome de usuário não está disponível.');
      throw error;
    }
  });

  const rotateTransaction = db.transaction((presented) => {
    const time = now();
    const hash = sha256(presented);
    let row = sql.sessionByRefresh.get(hash);
    if (!row) {
      row = sql.sessionByPrevious.get(hash);
      if (!row) return { status: 'invalid' };
      if (sessionUsable(row, time) && time - row.rotated_at > REFRESH_REUSE_GRACE_MS) {
        sql.revoke.run(time, row.id);
        return { status: 'reused' };
      }
    }
    if (!sessionUsable(row, time)) return { status: 'invalid' };
    const refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = nextExpiry(row.created_at, time);
    // The token that was current stays valid briefly as "previous", so a parallel tab still holding it is not logged out.
    sql.rotate.run(sha256(refreshToken), row.refresh_hash, time, expiresAt, row.id, row.refresh_hash);
    return { status: 'rotated', userId: row.user_id, sessionId: row.id, refreshToken, expiresAt };
  });

  return {
    accessTtlMs: accessTokens.ttlMs,

    userCount() {
      return sql.countUsers.get();
    },

    async register(usernameInput, passwordInput, { allowSignup }) {
      const username = normalizeUsername(usernameInput);
      const password = validatePassword(passwordInput);
      if (!allowSignup && sql.countUsers.get() > 0) throw authError('SIGNUP_DISABLED', 'O cadastro de novos usuários está desativado neste servidor.');
      const id = createUser(username, await hashPassword(password, passwordParams), allowSignup);
      return { id, username };
    },

    /** Returns the user for valid credentials, otherwise null. Unknown users cost the same work. */
    async verifyCredentials(usernameInput, passwordInput) {
      if (typeof usernameInput !== 'string' || typeof passwordInput !== 'string' || passwordInput.length > MAX_PASSWORD_LENGTH) return null;
      const row = sql.userByName.get(usernameInput.trim().toLowerCase());
      if (!row) {
        dummyHash ??= hashPassword('finance-chat-timing-equalizer', passwordParams);
        await verifyPassword(passwordInput, await dummyHash, passwordParams);
        return null;
      }
      const { valid, needsRehash } = await verifyPassword(passwordInput, row.password_hash, passwordParams);
      if (!valid) return null;
      if (needsRehash) sql.updateHash.run(await hashPassword(passwordInput, passwordParams), row.id);
      return { id: row.id, username: row.username };
    },

    createSession(userId) {
      const time = now();
      const sessionId = randomUUID();
      const refreshToken = randomBytes(32).toString('base64url');
      const expiresAt = nextExpiry(time, time);
      sql.insertSession.run(sessionId, userId, sha256(refreshToken), time, time, expiresAt);
      sql.purge.run(time, time - 24 * 60 * 60 * 1000);
      return tokensFor(userId, sessionId, refreshToken, expiresAt);
    },

    /** Rotates a refresh token. Returns { status: 'rotated' | 'invalid' | 'reused', ...tokens }. */
    refresh(refreshToken) {
      if (typeof refreshToken !== 'string' || refreshToken.length === 0 || refreshToken.length > 256) return { status: 'invalid' };
      const result = rotateTransaction(refreshToken);
      if (result.status !== 'rotated') return result;
      return { status: 'rotated', ...tokensFor(result.userId, result.sessionId, result.refreshToken, result.expiresAt) };
    },

    /** Validates the access token and that its session is still active (logout takes effect immediately). */
    authenticate(accessToken) {
      const claims = accessTokens.verify(accessToken);
      if (!claims) return null;
      const session = sql.sessionById.get(claims.sessionId);
      if (!sessionUsable(session, now()) || session.user_id !== claims.userId) return null;
      const user = sql.userById.get(claims.userId);
      return user ? { user, sessionId: session.id } : null;
    },

    logout({ accessToken, refreshToken }) {
      const time = now();
      const claims = accessTokens.verify(accessToken);
      if (claims) sql.revoke.run(time, claims.sessionId);
      if (typeof refreshToken === 'string' && refreshToken) {
        const hash = sha256(refreshToken);
        const row = sql.sessionByRefresh.get(hash) || sql.sessionByPrevious.get(hash);
        if (row) sql.revoke.run(time, row.id);
      }
    },
  };
}
