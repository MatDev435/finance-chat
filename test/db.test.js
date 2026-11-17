import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, migrate, openDatabase } from '../src/db.js';

test('creates the schema and records the migration version', () => {
  const db = openDatabase(':memory:');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all();
  assert.deepEqual(tables, ['actual_connections', 'sessions', 'user_settings', 'users']);
  assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  db.close();
});

test('migrations are idempotent', () => {
  const db = openDatabase(':memory:');
  assert.deepEqual(migrate(db), { from: MIGRATIONS.length, to: MIGRATIONS.length });
  db.close();
});

test('applies only the pending migrations', () => {
  const db = new Database(':memory:');
  const migrations = ['CREATE TABLE a (id INTEGER) STRICT;', 'CREATE TABLE b (id INTEGER) STRICT;'];
  migrate(db, migrations.slice(0, 1));
  assert.deepEqual(migrate(db, migrations), { from: 1, to: 2 });
  db.close();
});

test('a failed migration leaves the version untouched', () => {
  const db = new Database(':memory:');
  assert.throws(() => migrate(db, ['CREATE TABLE ok (id INTEGER);', 'THIS IS NOT SQL;']));
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  db.close();
});

test('refuses a database created by a newer version', () => {
  const db = new Database(':memory:');
  db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
  assert.throws(() => migrate(db), /mais nova/);
  db.close();
});

test('deleting a user cascades to sessions, connection and settings', () => {
  const db = openDatabase(':memory:');
  const { lastInsertRowid: userId } = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('ana', 'x', 1);
  db.prepare('INSERT INTO sessions (id, user_id, refresh_hash, rotated_at, created_at, expires_at) VALUES (?, ?, ?, 1, 1, 2)').run('s1', userId, 'h1');
  db.prepare("INSERT INTO actual_connections (user_id, server_url, sync_id, auth_method, server_secret, updated_at) VALUES (?, 'https://a', 'id', 'password', 'x', 1)").run(userId);
  db.prepare('INSERT INTO user_settings (user_id, default_account_id, updated_at) VALUES (?, ?, 1)').run(userId, 'acc');
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  for (const table of ['sessions', 'actual_connections', 'user_settings']) {
    assert.equal(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0, table);
  }
  db.close();
});

test('usernames are unique regardless of case', () => {
  const db = openDatabase(':memory:');
  const insert = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)');
  insert.run('Ana', 'x', 1);
  assert.throws(() => insert.run('ana', 'y', 1), /UNIQUE/);
  db.close();
});

test('database file is created with owner-only permissions and WAL mode', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'finance-chat-db-'));
  try {
    const file = join(dir, 'nested', 'finance-chat.sqlite');
    const db = openDatabase(file);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
