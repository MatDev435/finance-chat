import 'dotenv/config';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createActualManager } from './actual.js';
import { createApp } from './app.js';
import { createAuth } from './auth.js';
import { ConfigError, loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { installFetchTimeout } from './fetch-timeout.js';
import { createPendingStore } from './pending.js';
import { createSecretBox } from './secrets.js';
import { createUndoStore } from './undo.js';
import { createUserStore } from './user-store.js';
import { createAiStore } from './ai/store.js';

let config;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

// Before importing the Actual API, which captures globalThis.fetch when it loads.
installFetchTimeout();
const actualApi = await import('@actual-app/api');

const db = openDatabase(config.databasePath);
await mkdir(config.actualDataDir, { recursive: true, mode: 0o700 });
const actual = createActualManager({ api: actualApi, dataRoot: config.actualDataDir });

const app = createApp({
  config,
  auth: createAuth({ db, appSecret: config.appSecret }),
  store: createUserStore(db, createSecretBox(config.appSecret)),
  aiStore: createAiStore(db, createSecretBox(config.appSecret, 'openai-api-key-v1')),
  actual,
  pending: createPendingStore(),
  undo: createUndoStore(),
  publicDir: join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public'),
});

const server = createServer(app);
server.listen(config.port, config.host, () => {
  console.log(`Finance Chat ouvindo em http://${config.host}:${config.port} (dados em ${config.dataDir})`);
});

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} recebido, encerrando...`);
  setTimeout(() => process.exit(1), 10_000).unref();
  server.close();
  server.closeIdleConnections();
  await actual.shutdown();
  db.close();
  process.exit(0);
}
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
