/**
 * Search periods → explicit date ranges, computed by the backend from
 * "today" (APP_TIME_ZONE). The model only names the kind of period; the dates
 * are never computed by it (except an explicit range the user typed).
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(message) {
  const error = new Error(message);
  error.code = 'INVALID_COMMAND';
  throw error;
}

const pad = (value) => String(value).padStart(2, '0');
const iso = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const parse = (value) => {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};
const addDays = (value, days) => iso(new Date(parse(value).getTime() + days * DAY_MS));
const lastDay = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const minDate = (a, b) => (a < b ? a : b);

function validIso(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  return iso(parse(value)) === value;
}

/** Same day `months` months earlier, clamped to the end of shorter months (31/05 − 3 months = 28/02). */
function monthsBefore(value, months) {
  const [year, month, day] = value.split('-').map(Number);
  const total = year * 12 + (month - 1) - months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = (total % 12) + 1;
  return `${targetYear}-${pad(targetMonth)}-${pad(Math.min(day, lastDay(targetYear, targetMonth)))}`;
}

/**
 * `spec` = { period, periodCount, month, year, from, to } (plan.js names).
 * Returns { from: 'YYYY-MM-DD' | null, to: 'YYYY-MM-DD' } (from = null: no lower bound).
 */
export function resolvePeriod(spec, today) {
  const [year, month] = today.split('-').map(Number);
  const period = spec?.period || 'all';
  switch (period) {
    case 'all':
      return { from: null, to: today };
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const day = addDays(today, -1);
      return { from: day, to: day };
    }
    case 'this_week': {
      const weekday = (parse(today).getUTCDay() + 6) % 7; // Monday = 0
      return { from: addDays(today, -weekday), to: today };
    }
    case 'last_week': {
      const weekday = (parse(today).getUTCDay() + 6) % 7;
      const monday = addDays(today, -weekday - 7);
      return { from: monday, to: addDays(monday, 6) };
    }
    case 'this_month':
      return { from: `${year}-${pad(month)}-01`, to: today };
    case 'last_month': {
      const previousYear = month === 1 ? year - 1 : year;
      const previousMonth = month === 1 ? 12 : month - 1;
      return { from: `${previousYear}-${pad(previousMonth)}-01`, to: `${previousYear}-${pad(previousMonth)}-${pad(lastDay(previousYear, previousMonth))}` };
    }
    case 'this_year':
      return { from: `${year}-01-01`, to: today };
    case 'last_year':
      return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
    case 'last_days': {
      const count = spec.periodCount ?? 7;
      return { from: addDays(today, -(count - 1)), to: today };
    }
    case 'last_months':
      return { from: monthsBefore(today, spec.periodCount ?? 1), to: today };
    case 'month': {
      if (!spec.month) fail('Informe o mês da busca, por exemplo “em outubro”.');
      // Without a year: the most recent such month that has started (like "12/11" in dates.js).
      const targetYear = spec.year ?? (spec.month <= month ? year : year - 1);
      const from = `${targetYear}-${pad(spec.month)}-01`;
      if (from > today) fail('Esse mês ainda não começou.');
      return { from, to: minDate(`${targetYear}-${pad(spec.month)}-${pad(lastDay(targetYear, spec.month))}`, today) };
    }
    case 'year': {
      const targetYear = spec.year ?? year;
      if (`${targetYear}-01-01` > today) fail('Esse ano ainda não começou.');
      return { from: `${targetYear}-01-01`, to: minDate(`${targetYear}-12-31`, today) };
    }
    case 'range': {
      if (!validIso(spec.from) || !validIso(spec.to)) fail('Informe as datas de início e fim da busca.');
      if (spec.from > spec.to) fail('A data inicial da busca é depois da data final.');
      return { from: spec.from, to: spec.to };
    }
    default:
      fail('Período de busca desconhecido.');
  }
  return null;
}

/** At most this many months in a month-by-month answer. */
export const MAX_MONTHS = 24;

/**
 * Calendar months covered by a resolved range, each clipped to the range:
 * ('2026-08-15', '2026-10-03') → [{ month: '2026-08', from: '2026-08-15', to: '2026-08-31' }, …].
 */
export function monthSpans(from, to) {
  const spans = [];
  let [year, month] = from.split('-').map(Number);
  const [lastYear, lastMonth] = to.split('-').map(Number);
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    const start = `${year}-${pad(month)}-01`;
    const end = `${year}-${pad(month)}-${pad(lastDay(year, month))}`;
    spans.push({ month: `${year}-${pad(month)}`, from: start < from ? from : start, to: end > to ? to : end });
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return spans;
}

/** The first day of the month `count - 1` months before `to` (the start of the last `count` calendar months). */
export function startOfLastMonths(to, count) {
  const [year, month] = to.split('-').map(Number);
  const total = year * 12 + (month - 1) - (count - 1);
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}-01`;
}
