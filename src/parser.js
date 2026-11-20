import { takeLeadingDate, takeTrailingDate } from './dates.js';

const COMMANDS = new Map([
  ['gastei', 'expense'],
  ['comprei', 'expense'],
  ['mandei', 'expense'],
  ['ganhei', 'income'],
  ['recebi', 'income'],
]);

function fail(message) {
  const error = new Error(message);
  error.code = 'INVALID_COMMAND';
  throw error;
}

function normalizeText(input) {
  if (typeof input !== 'string') fail('Digite uma mensagem de texto.');
  return input.trim().replace(/\s+/g, ' ');
}

export function parseAmount(raw) {
  const value = raw.replace(/^(?:r\$|\$)\s*/i, '').replace(/\s*reais?\s*$/i, '').trim();
  if (!value) fail('Informe um valor depois de “gastei” ou “ganhei”.');

  let normalized;
  const separators = [...value].filter((character) => character === '.' || character === ',');
  const lastComma = value.lastIndexOf(',');
  const lastDot = value.lastIndexOf('.');

  if (!/^\d[\d.,]*$/.test(value) || /[.,]{2,}/.test(value)) {
    fail(`O valor “${value}” não é válido.`);
  }

  if (separators.length === 0) {
    normalized = value;
  } else if (lastComma !== -1 && lastDot !== -1) {
    // The last separator is the decimal separator: support both Brazilian and US notation.
    normalized = lastComma > lastDot
      ? value.replace(/\./g, '').replace(',', '.')
      : value.replace(/,/g, '');
  } else if (lastComma !== -1) {
    const decimalDigits = value.length - lastComma - 1;
    normalized = decimalDigits === 1 || decimalDigits === 2 ? value.replace(',', '.') : value.replace(/,/g, '');
  } else {
    const decimalDigits = value.length - lastDot - 1;
    normalized = decimalDigits === 1 || decimalDigits === 2 ? value : value.replace(/\./g, '');
  }

  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) fail(`O valor “${value}” não é válido.`);

  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) fail('O valor deve ser maior que zero.');
  return Math.round(amount * 100) / 100;
}

function normalizeCategory(category) {
  const value = category.trim().replace(/[?.!]+$/, '').replace(/\s+/g, ' ');
  if (!value) fail('Informe uma categoria.');
  return value.charAt(0).toLocaleUpperCase('pt-BR') + value.slice(1);
}

/*
 * "Quanto gastei com alimentação?", "quanto paguei no mercado em outubro?",
 * "quanto recebi de freela este ano?", "quanto gastei com alimentação nos
 * últimos 3 meses por mês?". The answer is a search of the chat's account
 * (sum, or one total per month). The term after the preposition may be a
 * category or a payee: the search decides with the budget (exact category
 * name first). Anything else after the verb is left to the AI.
 */
const SPENDING_HELP = 'Não entendi a pergunta. Use, por exemplo: “quanto gastei com alimentação em outubro?” ou “quanto gastei no mercado nos últimos 3 meses por mês?”.';
const SPENDING_VERB = /^quanto\s+(?:eu\s+)?(gastei|paguei|comprei|recebi|ganhei)\b/i;
const MONTH_NAMES = ['janeiro', 'fevereiro', 'mar[cç]o', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MONTH_PATTERN = MONTH_NAMES.join('|');
const NUMBER_WORDS = { um: 1, uma: 1, dois: 2, duas: 2, 'três': 3, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12 };
const COUNT = String.raw`(\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})`;
const BY_MONTH = /\s+(?:por\s+m[eê]s|(?:em\s+)?cada\s+m[eê]s|m[eê]s\s+a\s+m[eê]s|separad[oa]s?\s+por\s+m[eê]s)$/i;
const PERIODS = [
  [/\s+hoje$/i, () => ({ period: 'today' })],
  [/\s+ontem$/i, () => ({ period: 'yesterday' })],
  [/\s+(?:n?(?:esta|essa))\s+semana$/i, () => ({ period: 'this_week' })],
  [/\s+(?:na\s+)?semana\s+passada$/i, () => ({ period: 'last_week' })],
  [/\s+(?:no\s+)?m[eê]s\s+passado$/i, () => ({ period: 'last_month' })],
  [/\s+(?:n?(?:este|esse)|no)\s+m[eê]s(?:\s+atual)?$/i, () => ({ period: 'this_month' })],
  [/\s+(?:no\s+)?ano\s+passado$/i, () => ({ period: 'last_year' })],
  [/\s+n?(?:este|esse)\s+ano$/i, () => ({ period: 'this_year' })],
  [new RegExp(String.raw`\s+(?:n?os\s+)?[uú]ltimos\s+${COUNT}\s+(dias|meses)$`, 'i'), (match) => {
    const count = NUMBER_WORDS[match[1].toLocaleLowerCase('pt-BR')] ?? Number(match[1]);
    if (!count || count > 120) fail('Informe um período de até 120 dias ou meses.');
    return { period: /^d/i.test(match[2]) ? 'last_days' : 'last_months', periodCount: count };
  }],
  [new RegExp(String.raw`\s+(?:em|no\s+m[eê]s\s+de|de)\s+(${MONTH_PATTERN})(?:\s+(?:de\s+)?(\d{4}))?$`, 'i'), (match) => ({
    period: 'month',
    month: MONTH_NAMES.findIndex((name) => new RegExp(`^${name}$`, 'i').test(match[1])) + 1,
    year: match[2] ? Number(match[2]) : null,
  })],
  [/\s+(?:em|no\s+ano\s+de)\s+(\d{4})$/i, (match) => ({ period: 'year', year: Number(match[1]) })],
];
// A term that still carries a date, number or another question goes to the AI instead of being guessed.
const TERM_REJECT = new RegExp(String.raw`\d|\b(?:${MONTH_PATTERN}|hoje|ontem|semana|m[eê]s|meses|ano|dias?|[uú]ltim[oa]s?|quanto|e\s+(?:no|na|em|com))\b`, 'i');

function parseSpendingQuestion(text) {
  const verb = text.match(SPENDING_VERB);
  if (!verb) return null;
  let rest = text.replace(/[?.!]+$/, '').trim();
  let byMonth = false;
  let period = null;
  for (let pass = 0; pass < 2; pass += 1) {
    if (!byMonth && BY_MONTH.test(rest)) {
      byMonth = true;
      rest = rest.replace(BY_MONTH, '');
    }
    if (!period) {
      for (const [pattern, build] of PERIODS) {
        const match = rest.match(pattern);
        if (match) {
          period = build(match);
          rest = rest.slice(0, match.index);
          break;
        }
      }
    }
  }
  let after = rest.slice(verb[0].length).trim();
  const leadingByMonth = after.match(/^(?:por\s+m[eê]s|(?:em\s+)?cada\s+m[eê]s|m[eê]s\s+a\s+m[eê]s)(?:\s+|$)/i);
  if (leadingByMonth) {
    byMonth = true;
    after = after.slice(leadingByMonth[0].length);
  }
  let term = null;
  if (after) {
    const target = after.match(/^(?:com|em|no|na|nos|nas|de|do|da|dos|das|pro|pra|pela|pelo|para(?:\s+[oa]s?)?)\s+(?:(?:o|a|os|as)\s+)?(.+)$/i);
    if (!target || TERM_REJECT.test(target[1])) fail(SPENDING_HELP);
    term = /^(?:total|tudo|geral)$/i.test(target[1]) ? null : target[1].trim();
  }
  const type = ['recebi', 'ganhei'].includes(verb[1].toLocaleLowerCase('pt-BR')) ? 'income' : 'expense';
  return {
    kind: 'search',
    search: {
      followUp: false, term, payee: null, notes: null, category: null, type,
      period: period?.period ?? (byMonth ? null : 'all'), periodCount: period?.periodCount ?? null,
      month: period?.month ?? null, year: period?.year ?? null, from: null, to: null,
      minAmount: null, maxAmount: null, result: byMonth ? 'by_month' : 'sum', order: null, limit: null,
    },
  };
}

function parseAvailableCategoryQuestion(text) {
  if (!/^quanto\b/i.test(text) || SPENDING_VERB.test(text)) return null;
  const match = text.match(/^quanto\b.*?\b(?:categoria|em|com)\s+(.+?)(?:\s+(?:esse|este)\s+m[eê]s)?[?!.]*$/i);
  if (!match) return null;
  return { kind: 'category-available', category: normalizeCategory(match[1]) };
}

function parseCanSpendQuestion(text) {
  if (!/\b(?:gastar|usar)\b/i.test(text)) return null;
  const amountMatch = text.match(/(?:r\$|\$)?\s*\d[\d.,]*(?:\s+reais?)?/i);
  if (!amountMatch) return null;
  const amount = parseAmount(amountMatch[0]);
  const remainder = text.slice(amountMatch.index + amountMatch[0].length)
    .replace(/^[\s,]*(?:para\s+gastar\s+)?(?:na\s+categoria|no\s+categoria|em\s+uma?\s+categoria|com|em|na|no|para\s+(?:a|o)?|para)\s+/i, '')
    .replace(/[?.!]+$/, '')
    .trim();
  if (!remainder) fail('Informe uma categoria para consultar esse valor.');
  return { kind: 'category-can-spend', amount, category: normalizeCategory(remainder) };
}

export const MAX_SPLITS = 10;
const SPLIT_AMOUNT = String.raw`(?:r\$|\$)?\s*\d[\d.,]*(?:\s+reais?)?`;
const SPLIT_VALUE_FIRST = new RegExp(String.raw`^(${SPLIT_AMOUNT})\s+(?:(?:de|em|para|pra|com|na|no)\s+)?(.+)$`, 'i');
const SPLIT_VALUE_LAST = new RegExp(String.raw`^(.+?):?\s+(?:(?:de|com)\s+)?(${SPLIT_AMOUNT})$`, 'i');
// Separators: "," or ";" that are not a decimal comma (between digits), or " e " next to a number.
const SPLIT_SEPARATOR = /(?<!\d)[,;]\s*|[,;](?!\d)\s*|\s+e\s+(?=(?:r\$|\$)?\s*\d)|(?<=\d)\s+e\s+/i;

function centsText(cents) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * "70 alimentação, 30 limpeza" or "alimentação 70 e limpeza 30" → [{ amount, category }].
 * The parts must add up exactly to the total of the command.
 */
export function parseSplits(text, total) {
  const items = text.split(SPLIT_SEPARATOR).map((item) => item.trim()).filter(Boolean);
  if (items.length < 2) fail('Informe pelo menos duas partes depois de “categorias”, como: categorias 70 alimentação, 30 limpeza.');
  if (items.length > MAX_SPLITS) fail(`Divida a movimentação em no máximo ${MAX_SPLITS} partes.`);
  const splits = items.map((item) => {
    const valueFirst = /^(?:r\$|\$)?\s*\d/i.test(item) ? item.match(SPLIT_VALUE_FIRST) : null;
    const valueLast = valueFirst ? null : item.match(SPLIT_VALUE_LAST);
    if (!valueFirst && !valueLast) fail(`Não entendi a parte “${item}”. Use o formato “70 alimentação”.`);
    const [amountText, categoryText] = valueFirst ? [valueFirst[1], valueFirst[2]] : [valueLast[2], valueLast[1]];
    return { amount: parseAmount(amountText), category: normalizeCategory(categoryText) };
  });
  checkSplitTotal(splits, total);
  return splits;
}

/** The parts of a split must add up exactly to the total; nothing is ever adjusted silently. */
export function checkSplitTotal(splits, total) {
  const sum = splits.reduce((acc, split) => acc + amountToCents(split.amount), 0);
  if (sum !== amountToCents(total)) fail(`A soma das partes (${centsText(sum)}) é diferente do total (${centsText(amountToCents(total))}).`);
}

export function parseCommand(input) {
  let text = normalizeText(input);
  if (!text) fail('Digite uma mensagem financeira.');

  // Optional date before the command: "Ontem gastei...", "Dia 12, comprei...".
  let when;
  const leading = takeLeadingDate(text);
  if (leading && COMMANDS.has(leading.rest.split(' ')[0].toLocaleLowerCase('pt-BR'))) {
    when = leading.when;
    text = leading.rest;
  }

  const words = text.split(' ');
  const operation = COMMANDS.get(words[0].toLocaleLowerCase('pt-BR'));
  if (!operation) fail('A mensagem deve começar com uma palavra como “gastei”, “comprei”, “mandei”, “ganhei” ou “recebi”.');

  // "categoria X" (single category) or, only when "categoria" is absent, "categorias 70 X, 30 Y" (split).
  const keywordIndex = (pattern) => words.findIndex((word, index) => index > 1 && pattern.test(word));
  let categoryIndex = keywordIndex(/^categoria$/i);
  const isSplit = categoryIndex === -1 && (categoryIndex = keywordIndex(/^categorias:?$/i)) !== -1;
  if (categoryIndex === -1) fail('Informe a categoria usando a palavra “categoria”.');

  const beforeCategory = words.slice(1, categoryIndex).join(' ');
  const match = beforeCategory.match(/^(?:(?:r\$|\$)\s*)?(\d[\d.,]*)(?:\s+reais?)?(?:\s+e\s+(\d{1,2})\s+centavos?)?(?:\s+reais?)?\s+(.+)$/i);
  if (!match) fail('Informe um valor e uma descrição depois de “gastei” ou “ganhei”.');

  // The amount is immediately after the command; “reais” is optional.
  const currencyPrefix = beforeCategory.match(/^(?:r\$|\$)/i)?.[0] || '';
  const amountToken = `${currencyPrefix}${match[1]}`;
  const amount = match[2] ? parseAmount(`${amountToken}.${match[2]}`) : parseAmount(amountToken);
  const description = match[3].trim().replace(/^(?:para\s+(?:a|o)|no|na|para|pra|pro|da|do|em|de)\s+/i, '').replace(isSplit ? /[,:]+$/ : /,+$/, '').trim();
  if (!description) fail('Informe uma descrição ou estabelecimento.');

  const categoryWords = words.slice(categoryIndex + 1);
  const noteIndex = categoryWords.findIndex((word, index) => index > 0 && /^notas?:?$/i.test(word));
  let categoryText = (noteIndex === -1 ? categoryWords : categoryWords.slice(0, noteIndex)).join(' ').replace(/[\s,]+$/, '').trim();

  // Optional date at the end of the category: "categoria alimentação ontem", "categoria alimentação, dia 12".
  const trailing = takeTrailingDate(categoryText);
  if (trailing?.rest) {
    if (when) fail('Informe a data só uma vez.');
    when = trailing.when;
    categoryText = trailing.rest;
  }
  if (!categoryText) fail(isSplit ? 'Informe as partes depois de “categorias”.' : 'Informe uma categoria depois de “categoria”.');

  let notes;
  if (noteIndex !== -1) {
    notes = categoryWords.slice(noteIndex + 1).join(' ').replace(/^[,\s]+|[?.!]+$/g, '').trim();
    if (!notes) fail('Informe uma nota depois de “notas”.');
    notes = notes.charAt(0).toLocaleUpperCase('pt-BR') + notes.slice(1);
  }

  const command = { type: operation, amount, description };
  if (isSplit) command.splits = parseSplits(categoryText, amount);
  else command.category = categoryText.charAt(0).toLocaleUpperCase('pt-BR') + categoryText.slice(1);
  if (notes) command.notes = notes;
  if (when) command.when = when;
  return command;
}

/*
 * Month summary in fixed phrases (the AI handles free variations such as
 * "resumo de outubro"): "resumo", "resumo do mês", "me mostra o resumo do mês",
 * "como estou esse mês?", "como estão minhas finanças?", "resumo do mês passado",
 * "como foi o mês passado?".
 */
const SUMMARY_ASK = String.raw`(?:(?:me\s+)?(?:mostra|mostre|d[aá]|manda|quero|faz|fa[cç]a)\s+(?:(?:um|o)\s+)?)?`;
const SUMMARY_THIS = new RegExp(String.raw`^(?:${SUMMARY_ASK}resumo(?:\s+(?:d[oe]|deste|desse)\s+m[eê]s(?:\s+atual)?)?|como\s+(?:eu\s+)?(?:estou|t[oô]|est[aã]o\s+(?:as\s+)?(?:minhas\s+)?finan[cç]as|(?:est|t)[aá]\s+o\s+m[eê]s)(?:\s+(?:esse|este|neste|nesse)\s+m[eê]s)?)[?.!]*$`, 'i');
const SUMMARY_LAST = new RegExp(String.raw`^(?:${SUMMARY_ASK}resumo\s+do\s+m[eê]s\s+passado|como\s+foi\s+o\s+m[eê]s\s+passado)[?.!]*$`, 'i');

function parseSummaryRequest(text) {
  if (SUMMARY_THIS.test(text)) return { kind: 'summary', period: 'this_month' };
  if (SUMMARY_LAST.test(text)) return { kind: 'summary', period: 'last_month' };
  return null;
}

const UNDO_COMMAND = /^(?:desfazer|desfaz|desfaça|desfaca)(?:\s+(?:o\s+)?(?:último|ultimo)(?:\s+(?:lançamento|lancamento|registro|movimentação|movimentacao))?)?[.!]*$/i;

export function parseMessage(input) {
  const text = normalizeText(input);
  if (!text) fail('Digite uma mensagem financeira.');
  if (UNDO_COMMAND.test(text)) return { kind: 'undo' };
  return parseSummaryRequest(text)
    || parseSpendingQuestion(text)
    || parseCanSpendQuestion(text)
    || parseAvailableCategoryQuestion(text)
    || { kind: 'transaction', command: parseCommand(text) };
}

export function amountToCents(amount) {
  return Math.round(amount * 100);
}
