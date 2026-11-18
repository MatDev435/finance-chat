/**
 * Deterministic date expressions for commands:
 *   hoje · ontem · anteontem · dia 12 · dia 12/11 · dia 12/11/2026 · 12/11 · 12/11/26
 * optionally preceded by "em", "no" or "na". The parser only recognizes the
 * expression; resolveDate() turns it into YYYY-MM-DD relative to "today" in
 * APP_TIME_ZONE. Future dates are refused.
 */
const EXPRESSION = String.raw`(?:(?:em|no|na)\s+)?(?:(hoje|ontem|anteontem)|dia\s+(\d{1,2})(?:\/(\d{1,2})(?:\/(\d{4}|\d{2}))?)?|(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?)`;
const LEADING = new RegExp(String.raw`^${EXPRESSION}[\s,]+`, 'i');
const TRAILING = new RegExp(String.raw`(?:^|[\s,]+)${EXPRESSION}[.!]*$`, 'i');
const RELATIVE = { hoje: 0, ontem: 1, anteontem: 2 };
const DAY_MS = 24 * 60 * 60 * 1000;

function fail(message) {
  const error = new Error(message);
  error.code = 'INVALID_COMMAND';
  throw error;
}

function toWhen(match) {
  if (match[1]) return { daysAgo: RELATIVE[match[1].toLowerCase()] };
  const day = Number(match[2] ?? match[5]);
  const month = match[3] ?? match[6];
  const year = match[4] ?? match[7];
  return {
    day,
    month: month === undefined ? null : Number(month),
    year: year === undefined ? null : (year.length === 2 ? 2000 + Number(year) : Number(year)),
  };
}

/** "Ontem gastei..." → { when, rest: "gastei..." }, or null. */
export function takeLeadingDate(text) {
  const match = text.match(LEADING);
  return match ? { when: toWhen(match), rest: text.slice(match[0].length) } : null;
}

/** "alimentação, ontem" → { when, rest: "alimentação" }, or null. */
export function takeTrailingDate(text) {
  const match = text.match(TRAILING);
  return match ? { when: toWhen(match), rest: text.slice(0, match.index).replace(/[\s,]+$/, '') } : null;
}

const pad = (value) => String(value).padStart(2, '0');
const iso = (year, month, day) => `${year}-${pad(month)}-${pad(day)}`;
const shown = (year, month, day) => `${pad(day)}/${pad(month)}${year ? `/${year}` : ''}`;

function exists(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Resolves a parsed date expression to YYYY-MM-DD, never in the future. `today` is YYYY-MM-DD. */
export function resolveDate(when, today) {
  if (!when) return today;
  const [todayYear, todayMonth, todayDay] = today.split('-').map(Number);
  const todayUtc = Date.UTC(todayYear, todayMonth - 1, todayDay);
  const notFuture = (year, month, day) => Date.UTC(year, month - 1, day) <= todayUtc;

  if (when.daysAgo !== undefined) {
    const date = new Date(todayUtc - when.daysAgo * DAY_MS);
    return iso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }

  const { day, month, year } = when;
  if (!Number.isInteger(day) || day < 1 || day > 31) fail(`O dia ${day} não é válido.`);

  if (month === null) {
    // "dia 12": the most recent day 12 that is not in the future.
    for (let back = 0; back <= 12; back += 1) {
      const total = todayYear * 12 + (todayMonth - 1) - back;
      const candidateYear = Math.floor(total / 12);
      const candidateMonth = (total % 12) + 1;
      if (exists(candidateYear, candidateMonth, day) && notFuture(candidateYear, candidateMonth, day)) return iso(candidateYear, candidateMonth, day);
    }
    fail(`O dia ${day} não é válido.`);
  }

  if (month < 1 || month > 12 || !exists(2000, month, day)) fail(`A data ${shown(null, month, day)} não existe.`);

  if (year === null) {
    // "12/11": this year, or the previous one if that date has not happened yet (29/02: last leap year).
    for (let candidateYear = todayYear; candidateYear >= todayYear - 8; candidateYear -= 1) {
      if (exists(candidateYear, month, day) && notFuture(candidateYear, month, day)) return iso(candidateYear, month, day);
    }
    fail(`A data ${shown(null, month, day)} não existe.`);
  }

  if (year < 2000) fail(`O ano ${year} não é aceito.`);
  if (!exists(year, month, day)) fail(`A data ${shown(year, month, day)} não existe.`);
  if (!notFuture(year, month, day)) fail(`A data ${shown(year, month, day)} está no futuro. Informe uma data de hoje ou anterior.`);
  return iso(year, month, day);
}
