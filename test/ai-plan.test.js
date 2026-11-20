import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlan } from '../src/ai/plan.js';
import { DEVELOPER_PROMPT, PLAN_SCHEMA, buildRequest, weekdayOf } from '../src/ai/plan-schema.js';
import { findModel } from '../src/ai/models.js';
import { op, plan } from './support/fake-openai.js';

/** Walks the schema like the strict mode does: every object closed, every property required. */
function assertStrict(schema, path = '$') {
  if (Array.isArray(schema)) return schema.forEach((item, index) => assertStrict(item, `${path}[${index}]`));
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))) {
    assert.equal(schema.additionalProperties, false, `${path} must set additionalProperties: false`);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${path} must require every property`);
  }
  for (const [key, value] of Object.entries(schema)) if (typeof value === 'object') assertStrict(value, `${path}.${key}`);
}

test('the plan schema follows the Structured Outputs strict subset', () => {
  assert.equal(PLAN_SCHEMA.type, 'object');
  assert.equal(PLAN_SCHEMA.anyOf, undefined, 'the root cannot be anyOf');
  assertStrict(PLAN_SCHEMA);
  assert.ok(JSON.stringify(PLAN_SCHEMA).length < 6000, 'kept compact: it is sent with every request');
});

test('the request uses the configured model, strict json_schema, no storage and a cacheable fixed prefix', () => {
  const context = { today: '2026-11-19', weekday: 'thursday', currency: 'BRL', categories: ['Alimentação'], draft: null, lastSearch: null, message: 'oi' };
  const body = buildRequest({ model: findModel('gpt-6.2-sol'), context });
  assert.equal(body.model, 'gpt-6.2-sol');
  assert.deepEqual(body.text.format, { type: 'json_schema', name: 'finance_chat_plan', strict: true, schema: PLAN_SCHEMA });
  assert.equal(body.store, false);
  assert.deepEqual(body.reasoning, { effort: 'low' });
  assert.equal(body.input[0].role, 'developer');
  assert.equal(body.input[0].content[0].text, DEVELOPER_PROMPT);
  assert.deepEqual(body.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
  assert.deepEqual(body.prompt_cache_options, { mode: 'explicit' });
  assert.deepEqual(JSON.parse(body.input[1].content[0].text), context);
  assert.equal(body.instructions, undefined, 'top-level instructions are not cacheable on GPT-6.2+');
  assert.equal(DEVELOPER_PROMPT.includes('2026'), false, 'the fixed prefix has no per-request data');
  assert.equal(weekdayOf('2026-11-19'), 'thursday');
});

test('normalizes a transaction: amounts, dates, trimmed text, no invented category', () => {
  const result = normalizePlan(plan({ operations: [op.tx({ type: 'expense', amount: '45.00', payee: '  Farmácia  ', categoryHints: ['Saúde', ''], date: { daysAgo: 1, day: null, month: null, year: null } })] }));
  assert.deepEqual(result.operations, [{
    kind: 'transaction',
    item: { type: 'expense', amount: 45, description: 'Farmácia', category: null, hints: ['Saúde'], splits: null, notes: null, when: { daysAgo: 1 } },
  }]);
  const explicit = normalizePlan(plan({ operations: [op.tx({ amount: '1.234,50', category: 'alimentação', date: { daysAgo: null, day: 12, month: 10, year: null } })] }));
  assert.equal(explicit.operations[0].item.amount, 1234.5);
  assert.equal(explicit.operations[0].item.category, 'Alimentação');
  assert.deepEqual(explicit.operations[0].item.when, { day: 12, month: 10, year: null });
});

test('normalizes splits and drops the single category when a split is present', () => {
  const result = normalizePlan(plan({ operations: [op.tx({ amount: '300.00', payee: 'Mercado', category: 'Livre', splits: [{ amount: '150.00', category: 'alimentação' }, { amount: '150', category: 'livre' }] })] }));
  assert.deepEqual(result.operations[0].item.splits, [{ amount: 150, category: 'Alimentação' }, { amount: 150, category: 'Livre' }]);
  assert.equal(result.operations[0].item.category, null);
});

test('normalizes queries, searches, undo, unsupported, draft updates and the question', () => {
  const result = normalizePlan(plan({
    operations: [
      op.balance('livre'),
      op.simulate('transporte', '80'),
      op.search({ payee: "McDonald's", type: 'expense', period: 'last_months', periodCount: 3, result: 'sum' }),
      op.undo(),
      op.unsupported(),
    ],
    draftUpdates: [{ item: 2, part: null, field: 'category', value: 'saúde' }, { item: 1, part: 2, field: 'amount', value: '30' }],
    question: '  Em qual conta?  ',
  }));
  assert.deepEqual(result.operations.map((operation) => operation.kind), ['category-available', 'category-can-spend', 'search', 'undo', 'unsupported']);
  assert.equal(result.operations[0].category, 'Livre');
  assert.equal(result.operations[1].amount, 80);
  assert.equal(result.operations[2].search.periodCount, 3);
  assert.deepEqual(result.draftUpdates, [{ item: 2, part: null, field: 'category', value: 'Saúde' }, { item: 1, part: 2, field: 'amount', value: 30 }]);
  assert.equal(result.question, 'Em qual conta?');
});

test('rejects malformed, out-of-contract or oversized plans as a whole', () => {
  const bad = [
    null,
    [],
    { operations: [] },
    plan({ operations: [{ intent: 'run_sql', transaction: null, category: null, amount: null, search: null }] }),
    plan({ operations: [op.tx({ amount: 'cinquenta' })] }),
    plan({ operations: [op.tx({ amount: '-50' })] }),
    plan({ operations: [op.tx({ amount: '5000000000' })] }),
    plan({ operations: [op.tx({ type: 'transfer', amount: '10' })] }),
    plan({ operations: [{ ...op.tx({}), transaction: null }] }),
    plan({ operations: Array.from({ length: 11 }, () => op.undo()) }),
    plan({ operations: [op.search({ from: '19/11/2026' })] }),
    plan({ operations: [op.search({ limit: 500 })] }),
    plan({ draftUpdates: [{ item: 1, part: null, field: 'description', value: 'x' }] }),
    plan({ draftUpdates: [{ item: 1, part: null, field: 'amount', value: 'muito' }] }),
    { ...plan(), cancelDraft: 'yes' },
  ];
  for (const value of bad) assert.throws(() => normalizePlan(value), { code: 'AI_INVALID_PLAN' }, JSON.stringify(value)?.slice(0, 120));
});

test('a month without a day is refused with a question, never recorded as today', () => {
  assert.throws(() => normalizePlan(plan({ operations: [op.tx({ amount: '10', date: { daysAgo: null, day: null, month: 10, year: null } })] })), { code: 'INVALID_COMMAND', message: /dia/ });
});

test('strips control characters and caps text sizes', () => {
  const result = normalizePlan(plan({ operations: [op.tx({ amount: '10', payee: `Loja\u0000\n${'x'.repeat(500)}`, notes: 'linha 1\nlinha 2' })] }));
  const { item } = result.operations[0];
  assert.equal(item.description.includes('\u0000'), false);
  assert.ok(item.description.length <= 120);
  assert.equal(item.notes, 'Linha 1 linha 2');
});

test('normalizes the month summary and the notes filter of a search', () => {
  const normalized = normalizePlan(plan({ operations: [
    op.summary({ period: 'month', month: 10, year: null }),
    op.summary({ period: 'last_month' }),
    op.search({ notes: '  Monster\n', type: 'expense', period: 'all', result: 'sum' }),
  ] }));
  assert.deepEqual(normalized.operations[0], { kind: 'summary', summary: { period: 'month', month: 10, year: null } });
  assert.deepEqual(normalized.operations[1], { kind: 'summary', summary: { period: 'last_month', month: null, year: null } });
  assert.equal(normalized.operations[2].search.notes, 'Monster');
  for (const summary of [null, { period: 'next_month', month: null, year: null }, { period: 'month', month: 13, year: null }]) {
    assert.throws(() => normalizePlan(plan({ operations: [{ ...op.summary(), summary }] })), { code: 'AI_INVALID_PLAN' });
  }
  assert.match(DEVELOPER_PROMPT, /month_summary/);
  assert.match(DEVELOPER_PROMPT, /notes: an item or subject to find in the transaction notes/);
});
