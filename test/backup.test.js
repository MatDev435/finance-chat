import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createBackup } from '../src/backup.js';
import { openDatabase } from '../src/db.js';

test('creates a consistent, owner-only copy of a live WAL database and rotates old copies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'finance-chat-backup-'));
  try {
    const databasePath = join(dir, 'finance-chat.sqlite');
    const live = openDatabase(databasePath);
    live.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('ana', 'hash', 1);

    const destDir = join(dir, 'backups');
    let last;
    for (let day = 1; day <= 4; day += 1) {
      last = await createBackup({ databasePath, destDir, keep: 3, now: new Date(Date.UTC(2026, 10, day, 3, 0, 0)) });
    }
    assert.deepEqual(readdirSync(destDir), ['finance-chat-20261102-030000.sqlite', 'finance-chat-20261103-030000.sqlite', 'finance-chat-20261104-030000.sqlite']);
    if (process.platform !== 'win32') assert.equal(statSync(last.file).mode & 0o777, 0o600);

    const copy = new Database(last.file, { readonly: true });
    assert.equal(copy.prepare('SELECT username FROM users').pluck().get(), 'ana');
    assert.equal(copy.pragma('user_version', { simple: true }), live.pragma('user_version', { simple: true }));
    copy.close();
    live.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails clearly when the database does not exist', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'finance-chat-backup-'));
  try {
    await assert.rejects(() => createBackup({ databasePath: join(dir, 'missing.sqlite'), destDir: join(dir, 'b') }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
