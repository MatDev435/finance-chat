/**
 * Starts the real HTTP app with SQLite in memory, a fake Actual API and, for
 * the AI mode, a fake OpenAI transport. Nothing here touches the network:
 * the fake OpenAI fetch is injected and every test supplies its responses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createActualManager } from '../../src/actual.js';
import { createApp } from '../../src/app.js';
import { createAuth } from '../../src/auth.js';
import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db.js';
import { createPendingStore } from '../../src/pending.js';
import { createSecretBox } from '../../src/secrets.js';
import { createUserStore } from '../../src/user-store.js';
import { createAiStore } from '../../src/ai/store.js';
import { createBudget, createFakeActual } from './fake-actual.js';
import { createClient } from './http-client.js';

export const SECRET = 'z'.repeat(43);
const dataRoot = mkdtempSync(join(tmpdir(), 'finance-chat-app-'));
test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

export const CATEGORIES = [{ id: 'cat-food', name: 'Alimentação' }, { id: 'cat-salary', name: 'Salário' }];

export const ANA_CONNECTION = { serverUrl: 'https://ana.example/', syncId: 'sync-ana-0001', authMethod: 'password', serverSecret: 'ana-server-pass' };
export const BIA_CONNECTION = { serverUrl: 'https://bia.example', syncId: 'sync-bia-0001', authMethod: 'password', serverSecret: 'bia-server-pass' };

/**
 * `extraApp` is merged into the createApp() options (e.g. a fake OpenAI client).
 * `anaBudget` overrides parts of Ana's budget (accounts, categories, months, transactions).
 */
export async function startApp({ allowSignup = true, extraApp = {}, anaBudget = {}, categories = CATEGORIES } = {}) {
  const anaFile = createBudget({
    accounts: [
      { id: 'acc-nubank', name: 'Nubank' },
      { id: 'acc-inter', name: 'Inter' },
      { id: 'acc-closed', name: 'Antiga', closed: true },
    ],
    categories,
    months: { [new Date().toISOString().slice(0, 7)]: { categoryGroups: [{ categories: [{ id: 'cat-food', balance: 12345 }] }] } },
    ...anaBudget,
  });
  if (anaBudget.transactions) anaFile.transactions = anaBudget.transactions;
  const servers = {
    'https://ana.example': {
      password: 'ana-server-pass',
      token: 'ana-api-key',
      files: { 'sync-ana-0001': anaFile },
    },
    'https://bia.example': {
      password: 'bia-server-pass',
      files: { 'sync-bia-0001': createBudget({ accounts: [{ id: 'acc-carteira', name: 'Carteira' }], categories: CATEGORIES }) },
    },
  };
  const api = createFakeActual(servers);
  const db = openDatabase(':memory:');
  const config = loadConfig({ APP_SECRET: SECRET, ALLOW_SIGNUP: String(allowSignup), DATA_DIR: dataRoot });
  const logs = [];
  const aiStore = createAiStore(db, createSecretBox(SECRET, 'openai-api-key-v1'));
  const handler = createApp({
    config,
    auth: createAuth({ db, appSecret: SECRET, passwordParams: { N: 1024, r: 8, p: 1 } }),
    store: createUserStore(db, createSecretBox(SECRET)),
    aiStore,
    actual: createActualManager({ api, dataRoot }),
    pending: createPendingStore(),
    publicDir: fileURLToPath(new URL('../../public', import.meta.url)),
    log: { error: (...args) => logs.push(args.map(String).join(' ')), warn: (...args) => logs.push(args.map(String).join(' ')) },
    ...extraApp,
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => createClient(base, { origin: base });
  return { api, db, servers, base, client, logs, aiStore, budget: anaFile, close: () => new Promise((resolve) => server.close(resolve)) };
}

export async function signedIn(app, username, connection) {
  const client = app.client();
  assert.equal((await client.post('/api/auth/register', { username, password: 'senha-forte-1' })).status, 201);
  if (connection) assert.equal((await client.put('/api/connection', connection)).status, 200);
  return client;
}
