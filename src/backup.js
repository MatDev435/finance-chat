import Database from 'better-sqlite3';
import { chmodSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const PREFIX = 'finance-chat-';
const SUFFIX = '.sqlite';

function timestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/**
 * Consistent copy of the SQLite database using SQLite's online backup API,
 * safe while the service is running. Keeps the newest `keep` backups.
 */
export async function createBackup({ databasePath, destDir, keep = 14, now = new Date() }) {
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const target = join(destDir, `${PREFIX}${timestamp(now)}${SUFFIX}`);
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(target);
  } finally {
    db.close();
  }
  try { chmodSync(target, 0o600); } catch { /* not supported everywhere */ }

  const backups = readdirSync(destDir).filter((name) => name.startsWith(PREFIX) && name.endsWith(SUFFIX)).sort();
  const removed = backups.slice(0, Math.max(0, backups.length - keep));
  for (const name of removed) rmSync(join(destDir, name), { force: true });
  return { file: target, removed };
}
