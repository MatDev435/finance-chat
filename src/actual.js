import * as api from '@actual-app/api';
import { mkdir } from 'node:fs/promises';
import { getSynchronizedCategoryAvailability } from './budget-availability.js';

let initialized = false;
let connectionPromise;

function publicConnectionError(error) {
  const code = error?.code;
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  const result = new Error('Não foi possível consultar o Actual Budget.');
  if (code === 'invalid-password' || code === 'unauthorized' || code === 'token-expired' || message.includes('password')) {
    result.publicCode = 'authentication';
  } else if (code === 'budget-not-found') {
    result.publicCode = 'budget-not-found';
  } else if (code === 'missing-key' || code === 'decrypt-failure' || code === 'old-key-style') {
    result.publicCode = 'encryption';
  } else if (code === 'network' || code === 'network-failure') {
    result.publicCode = 'network';
  } else if (message.startsWith('configuração ausente:')) {
    result.publicCode = 'configuration';
  } else {
    result.publicCode = 'actual';
  }
  return result;
}

function required(name) {
  const value = process.env[name];
  if (!value || value.startsWith('replace-with-')) throw new Error(`Configuração ausente: ${name}`);
  return value;
}

async function connect() {
  if (initialized) return;
  if (!connectionPromise) {
    connectionPromise = (async () => {
      try {
        const dataDir = process.env.ACTUAL_DATA_DIR || './data/actual';
        await mkdir(dataDir, { recursive: true });
        await api.init({
          dataDir,
          serverURL: required('ACTUAL_SERVER_URL'),
          password: required('ACTUAL_SERVER_PASSWORD'),
        });
        const encryptionPassword = process.env.ACTUAL_ENCRYPTION_PASSWORD;
        await api.downloadBudget(required('ACTUAL_SYNC_ID'), encryptionPassword ? { password: encryptionPassword } : undefined);
        initialized = true;
      } catch (error) {
        throw publicConnectionError(error);
      }
    })().catch((error) => {
      connectionPromise = undefined;
      throw error;
    });
  }
  await connectionPromise;
}

export async function getAccounts() {
  await connect();
  return api.getAccounts();
}

export async function getCategories() {
  await connect();
  return api.getCategories();
}

export async function getCategoryAvailability(categoryName, month) {
  await connect();
  return getSynchronizedCategoryAvailability(api, categoryName, month);
}

export async function createTransaction(mappedTransaction) {
  await connect();
  const ids = await api.addTransactions(mappedTransaction.accountId, [mappedTransaction.transaction]);
  await api.sync();
  return ids;
}

export async function shutdown() {
  if (!initialized) return;
  initialized = false;
  connectionPromise = undefined;
  await api.shutdown();
}
