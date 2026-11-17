import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Ordered schema migrations. Each entry runs once, inside a transaction, and
 * bumps PRAGMA user_version. Never edit a released migration: append a new one.
 */
export const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_hash TEXT NOT NULL UNIQUE,
    previous_refresh_hash TEXT,
    rotated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
  ) STRICT;
  CREATE INDEX sessions_user_id ON sessions(user_id);
  CREATE INDEX sessions_previous_refresh_hash ON sessions(previous_refresh_hash);

  CREATE TABLE actual_connections (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    server_url TEXT NOT NULL,
    sync_id TEXT NOT NULL,
    auth_method TEXT NOT NULL CHECK (auth_method IN ('password', 'token')),
    server_secret TEXT NOT NULL,
    encryption_password TEXT,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE user_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    default_account_id TEXT,
    updated_at INTEGER NOT NULL
  ) STRICT;
  `,
];

export function migrate(db, migrations = MIGRATIONS) {
  const current = db.pragma('user_version', { simple: true });
  if (current > migrations.length) {
    throw new Error(`O banco de dados está na versão ${current}, mais nova que esta versão do Finance Chat (${migrations.length}). Atualize o código antes de iniciar.`);
  }
  for (let version = current; version < migrations.length; version += 1) {
    db.transaction(() => {
      db.exec(migrations[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
  return { from: current, to: migrations.length };
}

/** Opens (creating if needed) the SQLite database and applies pending migrations. */
export function openDatabase(file) {
  const inMemory = file === ':memory:';
  if (!inMemory) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  if (!inMemory) {
    // The database holds password hashes and encrypted credentials: owner-only access.
    try { chmodSync(file, 0o600); } catch { /* not supported on every filesystem */ }
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}
