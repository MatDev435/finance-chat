/**
 * OpenAI prices used to estimate the cost of each request.
 *
 * Unit: thousandths of a US dollar per 1 million tokens. With this unit,
 * `tokens × price` is the exact cost in nano-dollars (1e-9 USD), so every
 * cost is an integer and sums never drift (no floating point).
 *
 * Source: https://developers.openai.com/api/docs/pricing (Standard tier, short
 * context: up to 272K input tokens), checked on 2026-11-19.
 *
 * Versioning: never edit a published table. When prices change, append a new
 * table with a later `effectiveFrom`. A request is priced with the table in
 * force when it is recorded, and the cost is stored with the usage row, so a
 * new table never changes the history.
 */
export const PRICE_TABLES = Object.freeze([
  Object.freeze({
    version: '2026-11-19',
    effectiveFrom: '2026-11-19',
    source: 'https://developers.openai.com/api/docs/pricing',
    shortContextMaxInputTokens: 272_000,
    models: Object.freeze({
      'gpt-6-luna': Object.freeze({ input: 100, cachedInput: 10, cacheWrite30m: 125, cacheWrite12h: 250, output: 500 }),
      'gpt-6.1-terra': Object.freeze({ input: 1_000, cachedInput: 50, cacheWrite30m: 1_250, cacheWrite12h: 2_500, output: 5_000 }),
      'gpt-6.2-sol': Object.freeze({ input: 2_000, cachedInput: 100, cacheWrite30m: 2_500, cacheWrite12h: 5_000, output: 10_000 }),
      'gpt-6.2-astra': Object.freeze({ input: 8_000, cachedInput: 400, cacheWrite30m: 10_000, cacheWrite12h: 20_000, output: 40_000 }),
    }),
  }),
]);

/** Service tiers billed at the Standard rates above. Anything else is not estimated. */
const STANDARD_TIERS = new Set([undefined, null, 'default']);

const isoDay = (time) => new Date(time).toISOString().slice(0, 10);

/** The table in force at `time` (ms), or null when none is (before the first table). */
export function priceTableAt(time, tables = PRICE_TABLES) {
  const day = isoDay(time);
  let current = null;
  for (const table of tables) if (table.effectiveFrom <= day && (!current || table.effectiveFrom >= current.effectiveFrom)) current = table;
  return current;
}

/** "0.10" for 100 (thousandths of a dollar per 1M tokens). */
export function perMillionText(price) {
  return (price / 1000).toFixed(price % 10 === 0 ? 2 : 3);
}

/**
 * Estimated cost of one request, in nano-dollars, from the usage the API
 * returned (see normalizeUsage in openai-client.js):
 *
 *   uncached input = input − cached reads − cache writes   (official formula)
 *   cost = uncached × input + cached × cachedInput + writes(30m) × cacheWrite30m
 *        + writes(12h) × cacheWrite12h + output × output   (output includes reasoning)
 *
 * Returns { costNanoUsd: null, reason } instead of guessing when the model has
 * no known price, the request was not billed at Standard rates, the prompt was
 * a long-context one, or the counters are inconsistent.
 */
export function estimateCost(model, usage, { at = Date.now(), tables = PRICE_TABLES } = {}) {
  const table = priceTableAt(at, tables);
  if (!usage) return { costNanoUsd: null, pricingVersion: table?.version ?? null, reason: 'no-usage' };
  if (!table) return { costNanoUsd: null, pricingVersion: null, reason: 'no-price-table' };
  const price = table.models[model];
  if (!price) return { costNanoUsd: null, pricingVersion: table.version, reason: 'unknown-model' };
  if (!STANDARD_TIERS.has(usage.serviceTier)) return { costNanoUsd: null, pricingVersion: table.version, reason: 'service-tier' };
  if (usage.inputTokens > table.shortContextMaxInputTokens) return { costNanoUsd: null, pricingVersion: table.version, reason: 'long-context' };

  const writes = usage.cacheWriteTokens;
  let writes30m = usage.cacheWrite30mTokens;
  let writes12h = usage.cacheWrite12hTokens;
  if (writes30m + writes12h !== writes) {
    // Without the lifetime breakdown, the writes are the default 30-minute ones:
    // the Finance Chat never asks for the 12-hour lifetime.
    if (writes30m !== 0 || writes12h !== 0) return { costNanoUsd: null, pricingVersion: table.version, reason: 'inconsistent-usage' };
    writes30m = writes;
    writes12h = 0;
  }
  const uncached = usage.inputTokens - usage.cachedInputTokens - writes;
  if (uncached < 0) return { costNanoUsd: null, pricingVersion: table.version, reason: 'inconsistent-usage' };

  const costNanoUsd = uncached * price.input
    + usage.cachedInputTokens * price.cachedInput
    + writes30m * price.cacheWrite30m
    + writes12h * price.cacheWrite12h
    + usage.outputTokens * price.output;
  if (!Number.isSafeInteger(costNanoUsd)) return { costNanoUsd: null, pricingVersion: table.version, reason: 'overflow' };
  return { costNanoUsd, pricingVersion: table.version };
}
