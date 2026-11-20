import test from 'node:test';
import assert from 'node:assert/strict';
import { ANA_CONNECTION, BIA_CONNECTION, signedIn, startApp } from './support/app-harness.js';

// Fictitious key, used only in these tests.
const KEY = 'sk-test-0123456789abcdefFAKEKEY';

test('AI routes require a session and same-site JSON requests', async () => {
  const app = await startApp();
  const anonymous = app.client();
  assert.equal((await anonymous.get('/api/ai')).status, 401);
  assert.equal((await anonymous.put('/api/ai/settings', { enabled: true })).status, 401);
  const ana = await signedIn(app, 'ana', ANA_CONNECTION);
  const crossSite = await ana.put('/api/ai/settings', { enabled: true }, { headers: { origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403);
  const form = await ana.request('PUT', '/api/ai/settings', { body: 'enabled=true', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);
  assert.equal((await ana.get('/api/ai')).body.settings.enabled, false);
  await app.close();
});

test('the saved key is never sent back: not by the settings, /api/me or errors', async () => {
  const app = await startApp();
  const ana = await signedIn(app, 'ana', ANA_CONNECTION);
  const saved = await ana.put('/api/ai/settings', { enabled: true, apiKey: KEY, model: 'gpt-6.2-sol' });
  assert.equal(saved.status, 200);
  assert.deepEqual({ ...saved.body.settings, keyUpdatedAt: typeof saved.body.settings.keyUpdatedAt }, { enabled: true, model: 'gpt-6.2-sol', hasKey: true, keyUpdatedAt: 'number' });
  for (const response of [saved, await ana.get('/api/ai'), await ana.get('/api/me'), await ana.put('/api/ai/settings', { model: 'nope' })]) {
    assert.equal(response.text.includes(KEY), false);
    assert.equal(response.text.includes(KEY.slice(-8)), false);
  }
  assert.equal(app.logs.join('\n').includes(KEY), false);
  await app.close();
});

test('the settings page gets the models with prices, the price table and the usage summary', async () => {
  const app = await startApp();
  const ana = await signedIn(app, 'ana', ANA_CONNECTION);
  const { body } = await ana.get('/api/ai');
  assert.equal(body.defaultModel, 'gpt-6-luna');
  assert.deepEqual(body.models.map((model) => model.id), ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.2-sol', 'gpt-6.2-astra']);
  assert.deepEqual(body.models[0].prices, { input: '0.10', cachedInput: '0.01', output: '0.50' });
  assert.equal(body.pricing.version, '2026-11-19');
  assert.equal(body.usage.total.requests, 0);
  await app.close();
});

test('settings are per user, persist across sessions and ignore any user id in the body', async () => {
  const app = await startApp();
  const ana = await signedIn(app, 'ana', ANA_CONNECTION);
  const bia = await signedIn(app, 'bia', BIA_CONNECTION);
  await ana.put('/api/ai/settings', { enabled: true, apiKey: KEY, model: 'gpt-6.1-terra' });
  const attempt = await bia.put('/api/ai/settings', { userId: 1, user_id: 1, enabled: true });
  assert.equal(attempt.status, 200);
  assert.equal(attempt.body.settings.hasKey, false, 'Bia changed only her own settings');
  assert.equal((await bia.get('/api/ai')).body.settings.model, 'gpt-6-luna');

  await ana.post('/api/auth/logout');
  const again = app.client();
  assert.equal((await again.post('/api/auth/login', { username: 'ana', password: 'senha-forte-1' })).status, 200);
  const { body } = await again.get('/api/ai');
  assert.deepEqual({ ...body.settings, keyUpdatedAt: null }, { enabled: true, model: 'gpt-6.1-terra', hasKey: true, keyUpdatedAt: null });
  await app.close();
});

test('invalid settings are refused with the field, and turning the AI off keeps the key', async () => {
  const app = await startApp();
  const ana = await signedIn(app, 'ana', ANA_CONNECTION);
  assert.equal((await ana.put('/api/ai/settings', { model: 'gpt-4o' })).body.field, 'model');
  assert.equal((await ana.put('/api/ai/settings', { apiKey: 'chave-errada' })).body.field, 'apiKey');
  assert.equal((await ana.put('/api/ai/settings', { enabled: 'sim' })).body.field, 'enabled');
  await ana.put('/api/ai/settings', { enabled: true, apiKey: KEY });
  const off = await ana.put('/api/ai/settings', { enabled: false });
  assert.equal(off.body.settings.enabled, false);
  assert.equal(off.body.settings.hasKey, true);
  const removed = await ana.put('/api/ai/settings', { removeKey: true });
  assert.equal(removed.body.settings.hasKey, false);
  await app.close();
});

test('testing a typed key lists the models, probes the chosen one with the real schema and saves nothing', async () => {
  const app = await startApp();
  const ana = await signedIn(app, 'ana', ANA_CONNECTION);
  app.openai.replyModels(['gpt-6-luna', 'gpt-6.2-sol', 'whisper-1']).replyPlan({ operations: [], draftUpdates: [], cancelDraft: false, question: null }, { id: 'resp_probe' });
  const response = await ana.post('/api/ai/test', { apiKey: KEY, model: 'gpt-6.2-sol' });
  assert.equal(response.status, 200);
  assert.match(response.body.message, /GPT-6\.2 Sol/);
  assert.deepEqual(response.body.availableModels, ['gpt-6-luna', 'gpt-6.2-sol']);
  assert.equal(response.body.usage.total.requests, 1);
  const [list, probe] = app.openai.requests;
  assert.equal(list.url, 'https://api.openai.com/v1/models');
  assert.equal(probe.body.model, 'gpt-6.2-sol');
  assert.equal(probe.body.text.format.strict, true);
  assert.equal(probe.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(app.db.prepare("SELECT purpose FROM ai_usage WHERE response_id = 'resp_probe'").pluck().get(), 'test');
  assert.equal((await ana.get('/api/ai')).body.settings.hasKey, false, 'a test never saves the key');
  assert.equal(response.text.includes(KEY), false);
  await app.close();
});

test('the test reports an unavailable model without spending tokens, and uses the saved key when none is typed', async () => {
  const app = await startApp();
  const ana = await signedIn(app, 'ana', ANA_CONNECTION);
  assert.equal((await ana.post('/api/ai/test', {})).body.field, 'apiKey', 'no key typed or saved');
  await ana.put('/api/ai/settings', { apiKey: KEY, model: 'gpt-6.2-astra' });
  app.openai.replyModels(['gpt-6-luna']);
  const response = await ana.post('/api/ai/test', {});
  assert.equal(response.status, 502);
  assert.equal(response.body.code, 'AI_MODEL_UNAVAILABLE');
  assert.match(response.body.error, /GPT-6\.2 Astra/);
  assert.equal(app.openai.requests.length, 1, 'no probe request');
  assert.equal(app.openai.requests[0].headers.Authorization, `Bearer ${KEY}`);
  await app.close();
});

test('the test explains invalid keys, missing credit and rate limits, and never leaks the key in logs', async () => {
  const app = await startApp();
  const ana = await signedIn(app, 'ana', ANA_CONNECTION);
  app.openai.replyError(401, { code: 'invalid_api_key' });
  const invalid = await ana.post('/api/ai/test', { apiKey: KEY });
  assert.equal(invalid.body.code, 'AI_AUTH');
  assert.match(invalid.body.error, /recusou a chave/);

  app.openai.replyModels(['gpt-6-luna']).replyError(429, { type: 'insufficient_quota', code: 'credit_balance_exhausted' });
  const quota = await ana.post('/api/ai/test', { apiKey: KEY });
  assert.equal(quota.body.code, 'AI_QUOTA');
  assert.match(quota.body.error, /sem créditos/);

  app.openai.replyModels(['gpt-6-luna']).replyError(429, { code: 'rate_limit_exceeded' }, { 'retry-after': '20' });
  const limited = await ana.post('/api/ai/test', { apiKey: KEY });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'AI_RATE_LIMIT');
  assert.equal(limited.headers.get('retry-after'), '20');

  // A restricted key that cannot list models can still be tested by the probe.
  app.openai.replyError(403, { code: 'insufficient_permissions' }).replyPlan({ operations: [], draftUpdates: [], cancelDraft: false, question: null });
  const restricted = await ana.post('/api/ai/test', { apiKey: KEY });
  assert.equal(restricted.status, 200);
  assert.equal(restricted.body.availableModels, null);

  for (const text of [invalid.text, quota.text, limited.text, app.logs.join('\n')]) {
    assert.equal(text.includes(KEY), false);
    assert.equal(text.includes('Incorrect API key'), false);
  }
  await app.close();
});

test('key tests are rate limited per user', async () => {
  const app = await startApp();
  const ana = await signedIn(app, 'ana', ANA_CONNECTION);
  for (let attempt = 0; attempt < 10; attempt += 1) app.openai.replyError(401, { code: 'invalid_api_key' });
  for (let attempt = 0; attempt < 10; attempt += 1) assert.equal((await ana.post('/api/ai/test', { apiKey: KEY })).body.code, 'AI_AUTH');
  const blocked = await ana.post('/api/ai/test', { apiKey: KEY });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'TOO_MANY_ATTEMPTS');
  await app.close();
});
