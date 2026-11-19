import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIClient, normalizeUsage, readOutput } from '../src/ai/openai-client.js';
import { FAKE_KEY, createFakeOpenAI, plan, responseBody } from './support/fake-openai.js';

test('sends the key only in the Authorization header, to the Responses endpoint', async () => {
  const openai = createFakeOpenAI().replyPlan(plan());
  const client = createOpenAIClient({ fetch: openai.fetch });
  const { data } = await client.createResponse({ apiKey: FAKE_KEY, body: { model: 'gpt-6-luna' } });
  assert.equal(data.object, 'response');
  const [request] = openai.requests;
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(request.url.includes(FAKE_KEY), false, 'never in the URL');
  assert.equal(JSON.stringify(request.body).includes(FAKE_KEY), false, 'never in the body');
});

test('maps HTTP errors to stable codes without echoing OpenAI messages (which may quote the key)', async () => {
  const cases = [
    [401, { code: 'invalid_api_key' }, 'AI_AUTH'],
    [403, { code: 'unsupported_country_region_territory' }, 'AI_FORBIDDEN'],
    [404, { code: 'model_not_found' }, 'AI_MODEL_UNAVAILABLE'],
    [400, { param: 'model', code: 'model_not_found' }, 'AI_MODEL_UNAVAILABLE'],
    [400, { param: 'text.format', code: 'invalid_json_schema' }, 'AI_BAD_REQUEST'],
    [429, { type: 'insufficient_quota', code: 'credit_balance_exhausted' }, 'AI_QUOTA'],
    [429, { type: 'requests', code: 'project_spend_limit_exceeded' }, 'AI_QUOTA'],
    [429, { type: 'requests', code: 'rate_limit_exceeded' }, 'AI_RATE_LIMIT'],
    [500, {}, 'AI_UNAVAILABLE'],
    [503, { code: 'server_is_overloaded' }, 'AI_UNAVAILABLE'],
  ];
  for (const [status, error, code] of cases) {
    const openai = createFakeOpenAI().replyError(status, error, { 'x-request-id': 'req_123', 'retry-after': '7' });
    const client = createOpenAIClient({ fetch: openai.fetch });
    await assert.rejects(client.createResponse({ apiKey: FAKE_KEY, body: {} }), (failure) => {
      assert.equal(failure.code, code, `${status} ${JSON.stringify(error)}`);
      assert.equal(failure.status, status);
      assert.equal(failure.requestId, 'req_123');
      assert.equal(failure.maybeProcessed, false);
      assert.equal(failure.message.includes('sk-'), false);
      assert.equal(JSON.stringify(failure).includes('Incorrect API key'), false);
      return true;
    });
  }
});

test('rate limits carry Retry-After; timeouts and dropped connections may have been processed', async () => {
  const limited = createFakeOpenAI().replyError(429, { code: 'rate_limit_exceeded' }, { 'retry-after': '12' });
  await assert.rejects(createOpenAIClient({ fetch: limited.fetch }).createResponse({ apiKey: FAKE_KEY, body: {} }), { code: 'AI_RATE_LIMIT', retryAfter: 12 });

  const timeout = createFakeOpenAI().fail(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
  await assert.rejects(createOpenAIClient({ fetch: timeout.fetch }).createResponse({ apiKey: FAKE_KEY, body: {} }), { code: 'AI_TIMEOUT', maybeProcessed: true });

  const reset = createFakeOpenAI().fail(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
  await assert.rejects(createOpenAIClient({ fetch: reset.fetch }).createResponse({ apiKey: FAKE_KEY, body: {} }), { code: 'AI_NETWORK', maybeProcessed: true });

  const dns = createFakeOpenAI().fail(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
  await assert.rejects(createOpenAIClient({ fetch: dns.fetch }).createResponse({ apiKey: FAKE_KEY, body: {} }), { code: 'AI_NETWORK', maybeProcessed: false });
});

test('a real timeout aborts the request (the transport sees the abort signal)', async () => {
  const hanging = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  await assert.rejects(createOpenAIClient({ fetch: hanging, timeoutMs: 20 }).createResponse({ apiKey: FAKE_KEY, body: {} }), { code: 'AI_TIMEOUT' });
});

test('lists model ids with GET /v1/models', async () => {
  const openai = createFakeOpenAI().replyModels(['gpt-6-luna', 'gpt-6.2-sol', 'text-embedding-3-small']);
  assert.deepEqual(await createOpenAIClient({ fetch: openai.fetch }).listModels({ apiKey: FAKE_KEY }), ['gpt-6-luna', 'gpt-6.2-sol', 'text-embedding-3-small']);
  assert.equal(openai.requests[0].method, 'GET');
  assert.equal(openai.requests[0].url, 'https://api.openai.com/v1/models');
});

test('reads the usage counters of the Responses API, including cache writes and reasoning', () => {
  assert.deepEqual(normalizeUsage({
    input_tokens: 2000,
    input_tokens_details: { cached_tokens: 1100, cache_write_tokens: 300, cache_write_tokens_details: { ttl_30m_tokens: 300, ttl_12h_tokens: 0 } },
    output_tokens: 250,
    output_tokens_details: { reasoning_tokens: 90 },
    total_tokens: 2250,
  }, 'default'), {
    inputTokens: 2000, cachedInputTokens: 1100, cacheWriteTokens: 300, cacheWrite30mTokens: 300, cacheWrite12hTokens: 0,
    outputTokens: 250, reasoningTokens: 90, totalTokens: 2250, serviceTier: 'default',
  });
  assert.equal(normalizeUsage(undefined), null);
  assert.equal(normalizeUsage({ input_tokens: 'x', output_tokens: 1 }), null);
  assert.equal(normalizeUsage({ input_tokens: 10, output_tokens: 2 }).totalTokens, 12);
});

test('reads the structured output, refusals, truncation and garbage', () => {
  assert.deepEqual(readOutput(responseBody({ a: 1 })), { kind: 'json', value: { a: 1 } });
  assert.deepEqual(readOutput({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }), { kind: 'refusal' });
  assert.deepEqual(readOutput({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }), { kind: 'incomplete', reason: 'max_output_tokens' });
  assert.deepEqual(readOutput(responseBody(null, { text: '{"operations": [' })), { kind: 'invalid', reason: 'json' });
  assert.deepEqual(readOutput({ status: 'completed', output: [] }), { kind: 'invalid', reason: 'empty' });
  assert.deepEqual(readOutput({ status: 'failed', output: [] }), { kind: 'invalid', reason: 'status' });
});
