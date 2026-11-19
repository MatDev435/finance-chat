import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createSecretBox } from '../src/secrets.js';
import { createAiStore } from '../src/ai/store.js';
import { createOpenAIClient } from '../src/ai/openai-client.js';
import { createInterpreter } from '../src/ai/interpreter.js';
import { DEFAULT_USAGE, FAKE_KEY, createFakeOpenAI, op, plan } from './support/fake-openai.js';

const CONTEXT = { today: '2026-11-19', weekday: 'thursday', currency: 'BRL', categories: ['Alimentação'], draft: null, lastSearch: null, message: 'gastei 50 no mercado' };

function setup() {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('ana', 'x', 1)").run();
  const aiStore = createAiStore(db, createSecretBox('s'.repeat(43), 'openai-api-key-v1'), { localDate: () => '2026-11-19' });
  const openai = createFakeOpenAI();
  const logs = [];
  const interpreter = createInterpreter({
    client: createOpenAIClient({ fetch: openai.fetch }),
    aiStore,
    log: { error: (...args) => logs.push(args.join(' ')) },
    now: () => Date.UTC(2026, 10, 19),
  });
  return { db, aiStore, openai, interpreter, logs, rows: () => db.prepare('SELECT * FROM ai_usage ORDER BY id').all() };
}

const credentials = { model: 'gpt-6-luna', apiKey: FAKE_KEY };

test('a successful interpretation returns the raw plan and records real usage and cost', async () => {
  const { openai, interpreter, rows } = setup();
  const expected = plan({ operations: [op.tx({ amount: '50.00', payee: 'Mercado' })] });
  openai.replyPlan(expected, { id: 'resp_abc' });
  const result = await interpreter.interpret({ userId: 1, credentials, context: CONTEXT });
  assert.deepEqual(result, { plan: expected, responseId: 'resp_abc' });
  assert.equal(openai.requests[0].body.model, 'gpt-6-luna');
  const [row] = rows();
  assert.equal(row.purpose, 'chat');
  assert.equal(row.outcome, 'ok');
  assert.equal(row.response_id, 'resp_abc');
  assert.equal(row.input_tokens, DEFAULT_USAGE.input_tokens);
  assert.equal(row.output_tokens, DEFAULT_USAGE.output_tokens);
  assert.equal(row.reasoning_tokens, 60);
  assert.equal(row.cost_nano_usd, 1500 * 100 + 200 * 500, '$0.00025 at GPT-6 Luna rates');
  assert.equal(row.pricing_version, '2026-11-19');
  assert.equal(JSON.stringify(row).includes('mercado'), false, 'no message content in the usage table');
});

test('cached tokens reduce the recorded cost', async () => {
  const { openai, interpreter, rows } = setup();
  openai.replyPlan(plan(), { usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1500 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2100 } });
  await interpreter.interpret({ userId: 1, credentials, context: CONTEXT });
  assert.equal(rows()[0].cost_nano_usd, 500 * 100 + 1500 * 10 + 100 * 500);
  assert.equal(rows()[0].cached_input_tokens, 1500);
});

test('refusals, truncation and invalid JSON still record the consumed tokens', async () => {
  const { openai, interpreter, rows } = setup();
  openai.reply({ id: 'resp_r', status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Não posso.' }] }], usage: DEFAULT_USAGE });
  await assert.rejects(interpreter.interpret({ userId: 1, credentials, context: CONTEXT }), { code: 'AI_REFUSAL' });
  openai.reply({ id: 'resp_i', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [], usage: { ...DEFAULT_USAGE, output_tokens: 3000 } });
  await assert.rejects(interpreter.interpret({ userId: 1, credentials, context: CONTEXT }), { code: 'AI_INCOMPLETE' });
  openai.replyPlan(null, { id: 'resp_j', text: '{"operations":' });
  await assert.rejects(interpreter.interpret({ userId: 1, credentials, context: CONTEXT }), { code: 'AI_INVALID_OUTPUT' });
  assert.deepEqual(rows().map((row) => [row.response_id, row.outcome, row.usage_known]), [['resp_r', 'refusal', 1], ['resp_i', 'incomplete', 1], ['resp_j', 'invalid', 1]]);
  assert.equal(rows()[1].output_tokens, 3000);
});

test('HTTP errors record nothing (no usage, not billed); timeouts record a request with unknown usage', async () => {
  const { openai, interpreter, rows, logs } = setup();
  openai.replyError(401, { code: 'invalid_api_key' });
  await assert.rejects(interpreter.interpret({ userId: 1, credentials, context: CONTEXT }), { code: 'AI_AUTH' });
  openai.replyError(429, { type: 'insufficient_quota', code: 'credit_balance_exhausted' });
  await assert.rejects(interpreter.interpret({ userId: 1, credentials, context: CONTEXT }), { code: 'AI_QUOTA' });
  assert.equal(rows().length, 0);
  openai.fail(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
  await assert.rejects(interpreter.interpret({ userId: 1, credentials, context: CONTEXT }), { code: 'AI_TIMEOUT' });
  assert.deepEqual(rows().map((row) => [row.outcome, row.usage_known, row.input_tokens, row.cost_nano_usd]), [['timeout', 0, null, null]]);
  assert.equal(logs.join('\n').includes(FAKE_KEY), false);
  assert.equal(logs.join('\n').includes('Incorrect API key'), false);
  assert.match(logs.join('\n'), /AI_AUTH model=gpt-6-luna status=401 code=invalid_api_key/);
});

test('the same response is never counted twice', async () => {
  const { openai, interpreter, rows } = setup();
  openai.replyPlan(plan(), { id: 'resp_same' }).replyPlan(plan(), { id: 'resp_same' });
  await interpreter.interpret({ userId: 1, credentials, context: CONTEXT });
  await interpreter.interpret({ userId: 1, credentials, context: CONTEXT });
  assert.equal(rows().length, 1);
});

test('a model the catalog no longer offers is refused before any request', async () => {
  const { openai, interpreter } = setup();
  await assert.rejects(interpreter.interpret({ userId: 1, credentials: { model: 'gpt-4o', apiKey: FAKE_KEY }, context: CONTEXT }), { code: 'AI_MODEL_UNAVAILABLE' });
  assert.equal(openai.requests.length, 0);
});

test('usage without a known price is recorded with a null cost (never invented)', async () => {
  const { openai, interpreter, rows } = setup();
  openai.replyPlan(plan(), { serviceTier: 'flex' });
  await interpreter.interpret({ userId: 1, credentials, context: CONTEXT });
  assert.equal(rows()[0].usage_known, 1);
  assert.equal(rows()[0].cost_nano_usd, null);
});
