import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createSecretBox } from '../src/secrets.js';
import { createAiStore, resolveAiSettingsInput } from '../src/ai/store.js';

// Fictitious key, used only in these tests.
const KEY = 'sk-test-0123456789abcdefFAKEKEY';
const OTHER_KEY = 'sk-proj-ZYXWVUTSRQPONMLKJIfake';

function setup({ secret = 's'.repeat(43), month = '2026-11' } = {}) {
  const db = openDatabase(':memory:');
  const insert = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, 1)');
  insert.run('ana', 'x');
  insert.run('bia', 'x');
  let current = month;
  const store = createAiStore(db, createSecretBox(secret, 'openai-api-key-v1'), { localDate: () => `${current}-15` });
  return { db, store, setMonth: (value) => { current = value; } };
}

const usage = (input, output, extra = {}) => ({
  inputTokens: input, cachedInputTokens: 0, cacheWriteTokens: 0, cacheWrite30mTokens: 0, cacheWrite12hTokens: 0,
  outputTokens: output, reasoningTokens: 0, totalTokens: input + output, ...extra,
});

test('AI is disabled by default, with GPT-6 Luna preselected and no key', () => {
  const { store } = setup();
  assert.deepEqual(store.settings(1), { enabled: false, model: 'gpt-6-luna', hasKey: false, keyUpdatedAt: null });
  assert.equal(store.credentials(1), null);
});

test('the key is stored encrypted and only opened for requests when the AI is enabled', () => {
  const { db, store } = setup();
  store.update(1, { apiKey: KEY, model: 'gpt-6.2-sol' });
  const raw = db.prepare('SELECT * FROM ai_settings WHERE user_id = 1').get();
  assert.equal(JSON.stringify(raw).includes(KEY), false, 'never stored in clear text');
  assert.match(raw.api_key, /^v1\./);
  assert.equal(store.credentials(1), null, 'disabled: no credentials, no request');
  assert.equal(store.storedKey(1), KEY, 'an explicit test may still use it');
  store.update(1, { enabled: true });
  assert.deepEqual(store.credentials(1), { model: 'gpt-6.2-sol', apiKey: KEY });
  const settings = store.settings(1);
  assert.equal(settings.hasKey, true);
  assert.equal(JSON.stringify(settings).includes(KEY), false);
});

test('disabling keeps the saved key and model; replacing and removing the key work', () => {
  const { store } = setup();
  store.update(1, { enabled: true, apiKey: KEY });
  store.update(1, { enabled: false });
  assert.deepEqual({ ...store.settings(1), keyUpdatedAt: null }, { enabled: false, model: 'gpt-6-luna', hasKey: true, keyUpdatedAt: null });
  store.update(1, { enabled: true, apiKey: OTHER_KEY });
  assert.equal(store.credentials(1).apiKey, OTHER_KEY);
  store.update(1, { removeKey: true });
  assert.equal(store.settings(1).hasKey, false);
  assert.equal(store.credentials(1), null, 'enabled without a key is not usable');
});

test('settings and keys are isolated per user: a sealed key copied to another user does not decrypt', () => {
  const { db, store } = setup();
  store.update(1, { enabled: true, apiKey: KEY });
  assert.deepEqual(store.settings(2), { enabled: false, model: 'gpt-6-luna', hasKey: false, keyUpdatedAt: null });
  const sealed = db.prepare('SELECT api_key FROM ai_settings WHERE user_id = 1').pluck().get();
  db.prepare("INSERT INTO ai_settings (user_id, enabled, model, api_key, updated_at) VALUES (2, 1, 'gpt-6-luna', ?, 1)").run(sealed);
  assert.throws(() => store.credentials(2), { code: 'SECRET_UNREADABLE' });
});

test('a different APP_SECRET cannot read the stored key', () => {
  const first = setup({ secret: 'a'.repeat(43) });
  first.store.update(1, { enabled: true, apiKey: KEY });
  const sealed = first.db.prepare('SELECT api_key FROM ai_settings WHERE user_id = 1').pluck().get();
  const other = setup({ secret: 'b'.repeat(43) });
  other.db.prepare("INSERT INTO ai_settings (user_id, enabled, model, api_key, updated_at) VALUES (1, 1, 'gpt-6-luna', ?, 1)").run(sealed);
  assert.throws(() => other.store.credentials(1), { code: 'SECRET_UNREADABLE' });
});

test('the Actual credentials box and the OpenAI box use independent keys', () => {
  const secret = 'c'.repeat(43);
  const sealed = createSecretBox(secret, 'openai-api-key-v1').seal(KEY, 'user:1:openai_api_key');
  assert.throws(() => createSecretBox(secret).open(sealed, 'user:1:openai_api_key'), { code: 'SECRET_UNREADABLE' });
});

test('validates the settings form without echoing the key', () => {
  assert.deepEqual(resolveAiSettingsInput({ enabled: true, model: 'gpt-6.1-terra', apiKey: `  ${KEY}  ` }), { enabled: true, model: 'gpt-6.1-terra', apiKey: KEY });
  assert.deepEqual(resolveAiSettingsInput({ apiKey: '' }), {}, 'blank keeps the stored key');
  assert.deepEqual(resolveAiSettingsInput({ removeKey: true, apiKey: KEY }), { removeKey: true });
  assert.throws(() => resolveAiSettingsInput({ enabled: 'yes' }), { code: 'INVALID_INPUT', field: 'enabled' });
  assert.throws(() => resolveAiSettingsInput({ model: 'gpt-4o' }), { code: 'INVALID_INPUT', field: 'model' });
  for (const bad of ['not-a-key', 'sk-short', 'sk-has spaces inside the key value', 42, `sk-${'x'.repeat(600)}`]) {
    try {
      resolveAiSettingsInput({ apiKey: bad });
      assert.fail('accepted an invalid key');
    } catch (error) {
      assert.equal(error.code, 'INVALID_INPUT');
      assert.equal(error.field, 'apiKey');
      assert.equal(error.message.includes(String(bad)), false);
    }
  }
});

test('usage rows are unique per OpenAI response id (no double counting)', () => {
  const { db, store } = setup();
  const entry = { purpose: 'chat', model: 'gpt-6-luna', outcome: 'ok', responseId: 'resp_1', usage: usage(1000, 100), cost: { costNanoUsd: 150_000, pricingVersion: '2026-11-19' } };
  assert.equal(store.recordUsage(1, entry), true);
  assert.equal(store.recordUsage(1, entry), false);
  assert.equal(db.prepare('SELECT COUNT(*) FROM ai_usage').pluck().get(), 1);
});

test('summaries add up tokens and the stored costs, per user and per month', () => {
  const { store, setMonth } = setup({ month: '2026-10' });
  store.recordUsage(1, { purpose: 'chat', model: 'gpt-6-luna', outcome: 'ok', responseId: 'r1', usage: usage(1000, 100, { cachedInputTokens: 400, reasoningTokens: 30 }), cost: { costNanoUsd: 100_000, pricingVersion: 'v' } });
  setMonth('2026-11');
  store.recordUsage(1, { purpose: 'chat', model: 'gpt-6.2-sol', outcome: 'ok', responseId: 'r2', usage: usage(2000, 200), cost: { costNanoUsd: 6_000_000, pricingVersion: 'v' } });
  store.recordUsage(1, { purpose: 'test', model: 'gpt-6-luna', outcome: 'ok', responseId: 'r3', usage: usage(10, 5), cost: { costNanoUsd: null, pricingVersion: 'v', reason: 'unknown-model' } });
  store.recordUsage(1, { purpose: 'chat', model: 'gpt-6-luna', outcome: 'timeout', usage: null });
  store.recordUsage(2, { purpose: 'chat', model: 'gpt-6-luna', outcome: 'ok', responseId: 'r4', usage: usage(999, 999), cost: { costNanoUsd: 999, pricingVersion: 'v' } });

  const summary = store.usageSummary(1);
  assert.equal(summary.month, '2026-11');
  assert.deepEqual(summary.total, {
    requests: 4, requestsWithoutUsage: 1, requestsWithoutCost: 1,
    inputTokens: 3010, cachedInputTokens: 400, outputTokens: 305, reasoningTokens: 30, totalTokens: 3315, costNanoUsd: 6_100_000,
  });
  assert.equal(summary.currentMonth.requests, 3);
  assert.equal(summary.currentMonth.costNanoUsd, 6_000_000);
  assert.equal(store.usageSummary(2).total.requests, 1, 'other users never see these rows');
});

test('the history keeps its model and cost when the key or the model changes', () => {
  const { store } = setup();
  store.update(1, { enabled: true, apiKey: KEY, model: 'gpt-6-luna' });
  store.recordUsage(1, { purpose: 'chat', model: 'gpt-6-luna', outcome: 'ok', responseId: 'r1', usage: usage(100, 10), cost: { costNanoUsd: 15_000, pricingVersion: 'v' } });
  store.update(1, { apiKey: OTHER_KEY, model: 'gpt-6.2-astra' });
  store.update(1, { removeKey: true });
  assert.equal(store.usageSummary(1).total.costNanoUsd, 15_000);
  assert.equal(store.usageSummary(1).total.requests, 1);
});

test('a request whose plan was rejected keeps its consumption, with the outcome updated', () => {
  const { db, store } = setup();
  store.recordUsage(1, { purpose: 'chat', model: 'gpt-6-luna', outcome: 'ok', responseId: 'r1', usage: usage(100, 10), cost: { costNanoUsd: 15_000, pricingVersion: 'v' } });
  store.setOutcome(1, 'r1', 'rejected');
  store.setOutcome(2, 'r1', 'tampered');
  assert.equal(db.prepare("SELECT outcome FROM ai_usage WHERE response_id = 'r1'").pluck().get(), 'rejected');
  assert.equal(store.usageSummary(1).total.inputTokens, 100);
});
