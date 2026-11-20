/**
 * Fake OpenAI transport: a fetch replacement that records every request and
 * answers from a queue the test fills. No request ever leaves the process,
 * and an unexpected request fails the test.
 */
export const FAKE_KEY = 'sk-test-0123456789abcdefFAKEKEY';

export const DEFAULT_USAGE = Object.freeze({
  input_tokens: 1500,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 200,
  output_tokens_details: { reasoning_tokens: 60 },
  total_tokens: 1700,
});

let nextId = 1;

/** A Responses API body whose output text is the JSON of `plan`. */
export function responseBody(plan, { usage = DEFAULT_USAGE, id = `resp_fake${nextId++}`, status = 'completed', serviceTier = 'default', text } = {}) {
  return {
    id,
    object: 'response',
    status,
    model: 'gpt-6-luna',
    service_tier: serviceTier,
    output: [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: text ?? JSON.stringify(plan), annotations: [] }] },
    ],
    usage,
  };
}

const NULL_TRANSACTION = { type: 'expense', amount: null, payee: null, category: null, categoryHints: [], splits: null, notes: null, date: null };
const NULL_SEARCH = {
  followUp: false, payee: null, notes: null, category: null, type: null, period: null, periodCount: null, month: null, year: null,
  from: null, to: null, minAmount: null, maxAmount: null, result: null, order: null, limit: null,
};

export const op = {
  tx: (transaction) => ({ intent: 'create_transaction', transaction: { ...NULL_TRANSACTION, ...transaction }, category: null, amount: null, search: null, summary: null }),
  balance: (category) => ({ intent: 'category_balance', transaction: null, category, amount: null, search: null, summary: null }),
  simulate: (category, amount) => ({ intent: 'simulate_spend', transaction: null, category, amount, search: null, summary: null }),
  search: (search) => ({ intent: 'search_transactions', transaction: null, category: null, amount: null, search: { ...NULL_SEARCH, ...search }, summary: null }),
  summary: (summary) => ({ intent: 'month_summary', transaction: null, category: null, amount: null, search: null, summary: { period: 'this_month', month: null, year: null, ...summary } }),
  undo: () => ({ intent: 'undo', transaction: null, category: null, amount: null, search: null, summary: null }),
  unsupported: () => ({ intent: 'unsupported', transaction: null, category: null, amount: null, search: null, summary: null }),
};

export function plan({ operations = [], draftUpdates = [], cancelDraft = false, question = null } = {}) {
  return { operations, draftUpdates, cancelDraft, question };
}

export function createFakeOpenAI() {
  const requests = [];
  const queue = [];

  async function fetch(url, init = {}) {
    let body;
    try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = init.body; }
    requests.push({ url: String(url), method: init.method, headers: { ...init.headers }, body });
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected OpenAI request in test: ${init.method} ${url}`);
    if (next.error) throw next.error;
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'content-type': 'application/json', ...next.headers } });
  }

  return {
    fetch,
    requests,
    get pending() { return queue.length; },
    /** Queues a successful Responses API answer carrying `planValue`. */
    replyPlan(planValue, options) {
      queue.push({ body: responseBody(planValue, options) });
      return this;
    },
    reply(body, { status = 200, headers } = {}) {
      queue.push({ body, status, headers });
      return this;
    },
    replyError(status, error = {}, headers) {
      queue.push({ status, headers, body: { error: { message: 'Incorrect API key provided: sk-test-****FAKE.', type: 'invalid_request_error', param: null, code: null, ...error } } });
      return this;
    },
    replyModels(ids) {
      queue.push({ body: { object: 'list', data: ids.map((id) => ({ id, object: 'model', created: 1, owned_by: 'openai' })) } });
      return this;
    },
    fail(error) {
      queue.push({ error });
      return this;
    },
  };
}
