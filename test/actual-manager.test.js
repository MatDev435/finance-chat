import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextKey, createActualManager, toActualError } from '../src/actual.js';
import { createBudget, createFakeActual } from './support/fake-actual.js';

const dataRoot = mkdtempSync(join(tmpdir(), 'finance-chat-actual-'));
test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

function world() {
  const servers = {
    'https://ana.example': {
      password: 'ana-pass',
      token: 'ana-token',
      files: { 'sync-ana': createBudget({ accounts: [{ id: 'acc-ana', name: 'Nubank' }] }) },
    },
    'https://bia.example': {
      password: 'bia-pass',
      files: { 'sync-bia': createBudget({ accounts: [{ id: 'acc-bia', name: 'Inter' }], encryptionPassword: 'bia-e2e' }) },
    },
  };
  const api = createFakeActual(servers);
  const manager = createActualManager({ api, dataRoot });
  const ana = { userId: 1, serverUrl: 'https://ana.example', syncId: 'sync-ana', authMethod: 'password', serverSecret: 'ana-pass' };
  const bia = { userId: 2, serverUrl: 'https://bia.example', syncId: 'sync-bia', authMethod: 'password', serverSecret: 'bia-pass', encryptionPassword: 'bia-e2e' };
  return { servers, api, manager, ana, bia };
}

const accountIds = async (api) => (await api.getAccounts()).map((account) => account.id);

test('opens the budget once and reuses it for the same connection', async () => {
  const { api, manager, ana } = world();
  assert.deepEqual(await manager.run(ana, accountIds), ['acc-ana']);
  assert.deepEqual(await manager.run(ana, accountIds), ['acc-ana']);
  assert.equal(api.calls.filter((call) => call.op === 'init').length, 1);
});

test('uses a private cache directory per user and disables verbose logging', async () => {
  const { api, manager, ana, bia } = world();
  await manager.run(ana, accountIds);
  await manager.run(bia, accountIds);
  const inits = api.calls.filter((call) => call.op === 'init');
  assert.deepEqual(inits.map((call) => call.dataDir), [join(dataRoot, '1'), join(dataRoot, '2')]);
  assert.ok(inits.every((call) => call.verbose === false));
  if (process.platform !== 'win32') assert.equal(statSync(join(dataRoot, '1')).mode & 0o777, 0o700);
});

test('switching users shuts the previous budget down before opening the next', async () => {
  const { api, manager, ana, bia } = world();
  await manager.run(ana, accountIds);
  await manager.run(bia, accountIds);
  const ops = api.calls.map((call) => call.op);
  const secondInit = ops.lastIndexOf('init');
  assert.equal(ops[secondInit - 1], 'shutdown');
});

test('concurrent operations from different users never see each other\'s budget', async () => {
  const { manager, ana, bia } = world();
  const jobs = [];
  for (let index = 0; index < 30; index += 1) {
    const connection = index % 3 === 0 ? bia : ana;
    const expected = connection === ana ? 'acc-ana' : 'acc-bia';
    jobs.push(manager.run(connection, async (api) => {
      const first = await accountIds(api);
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 4));
      await api.addTransactions(expected, [{ date: '2026-11-16', amount: -100 }]);
      const second = await accountIds(api);
      return { expected, first, second };
    }));
  }
  for (const { expected, first, second } of await Promise.all(jobs)) {
    assert.deepEqual(first, [expected]);
    assert.deepEqual(second, [expected]);
  }
});

test('writes land only in the budget of the user who made them', async () => {
  const { servers, manager, ana, bia } = world();
  await Promise.all([
    manager.run(ana, (api) => api.addTransactions('acc-ana', [{ amount: -1 }])),
    manager.run(bia, (api) => api.addTransactions('acc-bia', [{ amount: -2 }])),
    manager.run(ana, (api) => api.addTransactions('acc-ana', [{ amount: -3 }])),
  ]);
  assert.deepEqual(servers['https://ana.example'].files['sync-ana'].transactions.map((t) => t.amount), [-1, -3]);
  assert.deepEqual(servers['https://bia.example'].files['sync-bia'].transactions.map((t) => t.amount), [-2]);
});

test('supports API keys (sessionToken) instead of the server password', async () => {
  const { api, manager, ana } = world();
  const withToken = { ...ana, authMethod: 'token', serverSecret: 'ana-token' };
  assert.deepEqual(await manager.run(withToken, accountIds), ['acc-ana']);
  await assert.rejects(() => manager.run({ ...withToken, serverSecret: 'nope' }, accountIds), { code: 'ACTUAL_ERROR', reason: 'token' });
  assert.equal(api.calls.some((call) => call.op === 'init'), true);
});

test('maps connection failures to clear messages', async () => {
  const { manager, ana, bia } = world();
  await assert.rejects(() => manager.run({ ...ana, serverSecret: 'wrong' }, accountIds), { reason: 'authentication', message: /recusou a senha/ });
  await assert.rejects(() => manager.run({ ...ana, syncId: 'missing' }, accountIds), { reason: 'budget-not-found' });
  await assert.rejects(() => manager.run({ ...ana, serverUrl: 'https://down.example' }, accountIds), { reason: 'network' });
  await assert.rejects(() => manager.run({ ...bia, encryptionPassword: undefined }, accountIds), { reason: 'encryption-required' });
  await assert.rejects(() => manager.run({ ...bia, encryptionPassword: 'bad' }, accountIds), { reason: 'encryption' });
});

test('public errors never contain secrets or raw API messages', async () => {
  const error = toActualError(Object.assign(new Error('Authentication failed: invalid-password for secret-value'), { code: 'invalid-password' }));
  assert.equal(error.message.includes('secret-value'), false);
  assert.equal(toActualError(Object.assign(new Error('x'), { name: 'TimeoutError' })).reason, 'network');
  assert.equal(toActualError(new Error('weird')).reason, 'actual');
});

test('a failed connection does not leave a budget marked as open', async () => {
  const { servers, api, manager, ana } = world();
  servers['https://ana.example'].offline = true;
  await assert.rejects(() => manager.run(ana, accountIds), { reason: 'network' });
  assert.equal(manager.activeKey, null);
  servers['https://ana.example'].offline = false;
  assert.deepEqual(await manager.run(ana, accountIds), ['acc-ana']);
  assert.equal(api.calls.filter((call) => call.op === 'init').length, 2);
});

test('an Actual failure during an operation closes the budget so the next call reconnects', async () => {
  const { api, manager, ana } = world();
  await manager.run(ana, accountIds);
  await assert.rejects(() => manager.run(ana, async () => { throw Object.assign(new Error('boom'), { code: 'network-failure' }); }), { reason: 'network' });
  assert.equal(manager.activeKey, null);
  await manager.run(ana, accountIds);
  assert.equal(api.calls.filter((call) => call.op === 'init').length, 2);
});

test('domain errors keep the budget open', async () => {
  const { manager, ana } = world();
  await assert.rejects(() => manager.run(ana, async () => { throw Object.assign(new Error('Conta indisponível'), { code: 'ACCOUNT_UNAVAILABLE' }); }), { code: 'ACCOUNT_UNAVAILABLE' });
  assert.equal(manager.activeKey, contextKey(ana));
});

test('changing any connection field reopens the budget', async () => {
  const { api, manager, ana } = world();
  await manager.run(ana, accountIds);
  assert.notEqual(contextKey(ana), contextKey({ ...ana, serverSecret: 'other' }));
  assert.notEqual(contextKey(ana), contextKey({ ...ana, userId: 9 }));
  await assert.rejects(() => manager.run({ ...ana, serverSecret: 'other' }, accountIds));
  assert.equal(api.calls.filter((call) => call.op === 'init').length, 2);
});

test('the queue keeps working after a failed operation', async () => {
  const { manager, ana } = world();
  const failing = manager.run(ana, async () => { throw new Error('x'); });
  const next = manager.run(ana, accountIds);
  await assert.rejects(failing);
  assert.deepEqual(await next, ['acc-ana']);
});

test('test() always opens from scratch with the candidate configuration', async () => {
  const { api, manager, ana } = world();
  await manager.run(ana, accountIds);
  assert.deepEqual(await manager.test(ana, accountIds), ['acc-ana']);
  assert.equal(api.calls.filter((call) => call.op === 'init').length, 2);
  await assert.rejects(() => manager.test({ ...ana, syncId: 'nope' }, accountIds), { reason: 'budget-not-found' });
  assert.equal(manager.activeKey, null);
});
