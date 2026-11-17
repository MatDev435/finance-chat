#!/usr/bin/env node
// Usage: npm run backup [-- <destination directory>]
// Defaults to <DATA_DIR>/backups and keeps the newest BACKUP_KEEP (14) files.
import 'dotenv/config';
import { join, resolve } from 'node:path';
import { createBackup } from '../src/backup.js';

const dataDir = resolve(process.env.DATA_DIR?.trim() || './data');
const destDir = resolve(process.argv[2] || join(dataDir, 'backups'));
const keep = Number(process.env.BACKUP_KEEP || 14);

try {
  const { file, removed } = await createBackup({ databasePath: join(dataDir, 'finance-chat.sqlite'), destDir, keep: Number.isInteger(keep) && keep > 0 ? keep : 14 });
  console.log(`Backup criado: ${file}`);
  if (removed.length) console.log(`Backups antigos removidos: ${removed.length}`);
} catch (error) {
  console.error(`Falha no backup: ${error.message}`);
  process.exit(1);
}
