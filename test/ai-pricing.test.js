import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_MODELS, DEFAULT_MODEL, findModel } from '../src/ai/models.js';
import { PRICE_TABLES, estimateCost, perMillionText, priceTableAt } from '../src/ai/pricing.js';

const usage = (fields = {}) => ({
  inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, cacheWrite30mTokens: 0, cacheWrite12hTokens: 0,
  outputTokens: 0, reasoningTokens: 0, totalTokens: 0, serviceTier: 'default', ...fields,
});
const NOV_2026 = Date.UTC(2026, 10, 20);

test('every offered model has a price in the current table, and the default is GPT-6 Luna', () => {
  assert.equal(DEFAULT_MODEL, 'gpt-6-luna');
  assert.ok(findModel(DEFAULT_MODEL));
  const table = priceTableAt(NOV_2026);
  for (const model of AI_MODELS) assert.ok(table.models[model.id], model.id);
  assert.equal(findModel('gpt-4o'), null);
});

test('official GPT-6 Luna rates: $0.10 input, $0.01 cached, $0.125 cache write, $0.50 output per 1M', () => {
  const luna = priceTableAt(NOV_2026).models['gpt-6-luna'];
  assert.deepEqual([luna.input, luna.cachedInput, luna.cacheWrite30m, luna.output].map(perMillionText), ['0.10', '0.01', '0.125', '0.50']);
});

test('costs are exact integers in nano-dollars (input + output, reasoning included in output)', () => {
  // 1500 × $0.10/M + 200 × $0.50/M = $0.00015 + $0.0001 = $0.00025
  assert.deepEqual(estimateCost('gpt-6-luna', usage({ inputTokens: 1500, outputTokens: 200, reasoningTokens: 120 }), { at: NOV_2026 }), { costNanoUsd: 250_000, pricingVersion: '2026-11-19' });
  // GPT-6.2 Astra: 1000 × $8/M + 100 × $40/M = $0.008 + $0.004
  assert.equal(estimateCost('gpt-6.2-astra', usage({ inputTokens: 1000, outputTokens: 100 }), { at: NOV_2026 }).costNanoUsd, 12_000_000);
});

test('cached reads and cache writes are priced separately from uncached input', () => {
  // uncached = 2000 − 1200 cached − 0 writes = 800
  assert.equal(estimateCost('gpt-6-luna', usage({ inputTokens: 2000, cachedInputTokens: 1200, outputTokens: 100 }), { at: NOV_2026 }).costNanoUsd, 800 * 100 + 1200 * 10 + 100 * 500);
  // uncached = 2000 − 1300 writes (30 min) = 700
  assert.equal(estimateCost('gpt-6-luna', usage({ inputTokens: 2000, cacheWriteTokens: 1300, cacheWrite30mTokens: 1300 }), { at: NOV_2026 }).costNanoUsd, 700 * 100 + 1300 * 125);
  // 12-hour writes use their own rate
  assert.equal(estimateCost('gpt-6-luna', usage({ inputTokens: 1000, cacheWriteTokens: 1000, cacheWrite12hTokens: 1000 }), { at: NOV_2026 }).costNanoUsd, 1000 * 250);
  // writes without the lifetime breakdown are the default 30-minute ones
  assert.equal(estimateCost('gpt-6-luna', usage({ inputTokens: 1000, cacheWriteTokens: 1000 }), { at: NOV_2026 }).costNanoUsd, 1000 * 125);
});

test('never guesses: unknown model, other service tier, long context or inconsistent counters', () => {
  assert.deepEqual(estimateCost('gpt-unknown', usage({ inputTokens: 10 }), { at: NOV_2026 }), { costNanoUsd: null, pricingVersion: '2026-11-19', reason: 'unknown-model' });
  assert.equal(estimateCost('gpt-6-luna', usage({ inputTokens: 10, serviceTier: 'flex' }), { at: NOV_2026 }).reason, 'service-tier');
  assert.equal(estimateCost('gpt-6-luna', usage({ inputTokens: 300_000 }), { at: NOV_2026 }).reason, 'long-context');
  assert.equal(estimateCost('gpt-6-luna', usage({ inputTokens: 10, cachedInputTokens: 50 }), { at: NOV_2026 }).reason, 'inconsistent-usage');
  assert.equal(estimateCost('gpt-6-luna', usage({ inputTokens: 100, cacheWriteTokens: 50, cacheWrite30mTokens: 10, cacheWrite12hTokens: 10 }), { at: NOV_2026 }).reason, 'inconsistent-usage');
  assert.equal(estimateCost('gpt-6-luna', null, { at: NOV_2026 }).reason, 'no-usage');
});

test('versioned tables: a request is priced with the table in force at that moment', () => {
  const tables = [
    ...PRICE_TABLES,
    { version: '2027-03-01', effectiveFrom: '2027-03-01', source: 'test', shortContextMaxInputTokens: 272_000, models: { 'gpt-6-luna': { input: 200, cachedInput: 20, cacheWrite30m: 250, cacheWrite12h: 500, output: 1000 } } },
  ];
  const sample = usage({ inputTokens: 1000, outputTokens: 1000 });
  assert.deepEqual(estimateCost('gpt-6-luna', sample, { at: NOV_2026, tables }), { costNanoUsd: 600_000, pricingVersion: '2026-11-19' });
  assert.deepEqual(estimateCost('gpt-6-luna', sample, { at: Date.UTC(2027, 2, 1), tables }), { costNanoUsd: 1_200_000, pricingVersion: '2027-03-01' });
  assert.equal(priceTableAt(Date.UTC(2020, 0, 1), tables), null);
  assert.equal(estimateCost('gpt-6-luna', sample, { at: Date.UTC(2020, 0, 1), tables }).reason, 'no-price-table');
});
