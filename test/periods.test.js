import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePeriod } from '../src/periods.js';

const TODAY = '2026-11-19'; // a Thursday
const period = (spec, today = TODAY) => resolvePeriod({ periodCount: null, month: null, year: null, from: null, to: null, ...spec }, today);

test('relative periods end today and never in the future', () => {
  assert.deepEqual(period({ period: 'all' }), { from: null, to: TODAY });
  assert.deepEqual(period({ period: null }), { from: null, to: TODAY });
  assert.deepEqual(period({ period: 'today' }), { from: TODAY, to: TODAY });
  assert.deepEqual(period({ period: 'yesterday' }), { from: '2026-11-18', to: '2026-11-18' });
  assert.deepEqual(period({ period: 'this_week' }), { from: '2026-11-16', to: TODAY });
  assert.deepEqual(period({ period: 'last_week' }), { from: '2026-11-09', to: '2026-11-15' });
  assert.deepEqual(period({ period: 'this_month' }), { from: '2026-11-01', to: TODAY });
  assert.deepEqual(period({ period: 'last_month' }), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(period({ period: 'this_year' }), { from: '2026-01-01', to: TODAY });
  assert.deepEqual(period({ period: 'last_year' }), { from: '2025-01-01', to: '2025-12-31' });
  assert.deepEqual(period({ period: 'last_days', periodCount: 7 }), { from: '2026-11-13', to: TODAY });
  assert.deepEqual(period({ period: 'last_months', periodCount: 3 }), { from: '2026-08-19', to: TODAY });
});

test('month boundaries: January, leap years and short months', () => {
  assert.deepEqual(period({ period: 'last_month' }, '2026-01-10'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(period({ period: 'last_months', periodCount: 3 }, '2026-05-31'), { from: '2026-02-28', to: '2026-05-31' });
  assert.deepEqual(period({ period: 'month', month: 2, year: 2024 }), { from: '2024-02-01', to: '2024-02-29' }, 'leap year');
  assert.deepEqual(period({ period: 'this_week' }, '2026-11-16'), { from: '2026-11-16', to: '2026-11-16' }, 'Monday');
  assert.deepEqual(period({ period: 'this_week' }, '2026-11-22'), { from: '2026-11-16', to: '2026-11-22' }, 'Sunday');
});

test('a month without a year is the most recent one that has started', () => {
  assert.deepEqual(period({ period: 'month', month: 10 }), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(period({ period: 'month', month: 11 }), { from: '2026-11-01', to: TODAY }, 'the current month ends today');
  assert.deepEqual(period({ period: 'month', month: 12 }), { from: '2025-12-01', to: '2025-12-31' });
  assert.throws(() => period({ period: 'month', month: 12, year: 2026 }), { code: 'INVALID_COMMAND' });
  assert.throws(() => period({ period: 'month' }), { code: 'INVALID_COMMAND' });
});

test('years and explicit ranges are validated', () => {
  assert.deepEqual(period({ period: 'year', year: 2025 }), { from: '2025-01-01', to: '2025-12-31' });
  assert.deepEqual(period({ period: 'year' }), { from: '2026-01-01', to: TODAY });
  assert.throws(() => period({ period: 'year', year: 2027 }), { code: 'INVALID_COMMAND' });
  assert.deepEqual(period({ period: 'range', from: '2026-10-01', to: '2026-10-15' }), { from: '2026-10-01', to: '2026-10-15' });
  assert.throws(() => period({ period: 'range', from: '2026-10-15', to: '2026-10-01' }), { code: 'INVALID_COMMAND' });
  assert.throws(() => period({ period: 'range', from: '2026-02-30', to: '2026-03-01' }), { code: 'INVALID_COMMAND' });
  assert.throws(() => period({ period: 'range', from: null, to: null }), { code: 'INVALID_COMMAND' });
});
