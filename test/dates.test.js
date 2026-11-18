import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDate, takeLeadingDate, takeTrailingDate } from '../src/dates.js';

test('without a date expression the transaction uses today', () => {
  assert.equal(resolveDate(undefined, '2026-11-18'), '2026-11-18');
});

test('hoje, ontem and anteontem, including month and year boundaries', () => {
  assert.equal(resolveDate({ daysAgo: 0 }, '2026-11-18'), '2026-11-18');
  assert.equal(resolveDate({ daysAgo: 1 }, '2026-11-18'), '2026-11-17');
  assert.equal(resolveDate({ daysAgo: 2 }, '2026-11-18'), '2026-11-16');
  assert.equal(resolveDate({ daysAgo: 1 }, '2026-03-01'), '2026-02-28');
  assert.equal(resolveDate({ daysAgo: 1 }, '2028-03-01'), '2028-02-29');
  assert.equal(resolveDate({ daysAgo: 2 }, '2027-01-01'), '2026-12-30');
});

test('"dia N" is the most recent day N that is not in the future', () => {
  const day = (value) => ({ day: value, month: null, year: null });
  assert.equal(resolveDate(day(12), '2026-11-18'), '2026-11-12');
  assert.equal(resolveDate(day(18), '2026-11-18'), '2026-11-18');
  assert.equal(resolveDate(day(25), '2026-11-18'), '2026-10-25');
  assert.equal(resolveDate(day(31), '2026-11-18'), '2026-10-31');
  assert.equal(resolveDate(day(31), '2026-01-05'), '2025-12-31');
  assert.equal(resolveDate(day(30), '2026-03-05'), '2026-01-30', 'February has no day 30');
  assert.throws(() => resolveDate(day(0), '2026-11-18'), { code: 'INVALID_COMMAND' });
  assert.throws(() => resolveDate(day(32), '2026-11-18'), { code: 'INVALID_COMMAND' });
});

test('"D/M" is this year, or last year when the date has not happened yet', () => {
  const dm = (day, month) => ({ day, month, year: null });
  assert.equal(resolveDate(dm(12, 11), '2026-11-18'), '2026-11-12');
  assert.equal(resolveDate(dm(25, 12), '2026-11-18'), '2025-12-25');
  assert.equal(resolveDate(dm(29, 2), '2026-11-18'), '2024-02-29', 'last 29/02');
  assert.throws(() => resolveDate(dm(31, 4), '2026-11-18'), /A data 31\/04 não existe/);
  assert.throws(() => resolveDate(dm(10, 13), '2026-11-18'), { code: 'INVALID_COMMAND' });
});

test('full dates are validated and never in the future', () => {
  assert.equal(resolveDate({ day: 3, month: 11, year: 2026 }, '2026-11-18'), '2026-11-03');
  assert.equal(resolveDate({ day: 18, month: 11, year: 2026 }, '2026-11-18'), '2026-11-18');
  assert.throws(() => resolveDate({ day: 19, month: 11, year: 2026 }, '2026-11-18'), /está no futuro/);
  assert.throws(() => resolveDate({ day: 29, month: 2, year: 2026 }, '2026-11-18'), /29\/02\/2026 não existe/);
  assert.throws(() => resolveDate({ day: 1, month: 1, year: 1999 }, '2026-11-18'), /1999/);
});

test('recognizes leading and trailing expressions only in their own form', () => {
  assert.deepEqual(takeLeadingDate('Ontem, gastei 40'), { when: { daysAgo: 1 }, rest: 'gastei 40' });
  assert.deepEqual(takeLeadingDate('no dia 12/11 comprei'), { when: { day: 12, month: 11, year: null }, rest: 'comprei' });
  assert.deepEqual(takeLeadingDate('3/11/26 gastei'), { when: { day: 3, month: 11, year: 2026 }, rest: 'gastei' });
  assert.equal(takeLeadingDate('gastei ontem'), null);
  assert.deepEqual(takeTrailingDate('alimentação, dia 12.'), { when: { day: 12, month: null, year: null }, rest: 'alimentação' });
  assert.deepEqual(takeTrailingDate('transporte em 12/11/2026'), { when: { day: 12, month: 11, year: 2026 }, rest: 'transporte' });
  assert.equal(takeTrailingDate('dia das mães'), null);
  assert.equal(takeTrailingDate('presentes de hojeemdia'), null);
});
