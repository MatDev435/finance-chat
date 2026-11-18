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

function parseAvailableCategoryQuestion(text) {
  if (!/^quanto\b/i.test(text)) return null;
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

  const categoryIndex = words.findIndex((word, index) => index > 1 && word.toLocaleLowerCase('pt-BR') === 'categoria');
  if (categoryIndex === -1) fail('Informe a categoria usando a palavra “categoria”.');

  const beforeCategory = words.slice(1, categoryIndex).join(' ');
  const match = beforeCategory.match(/^(?:(?:r\$|\$)\s*)?(\d[\d.,]*)(?:\s+reais?)?(?:\s+e\s+(\d{1,2})\s+centavos?)?(?:\s+reais?)?\s+(.+)$/i);
  if (!match) fail('Informe um valor e uma descrição depois de “gastei” ou “ganhei”.');

  // The amount is immediately after the command; “reais” is optional.
  const currencyPrefix = beforeCategory.match(/^(?:r\$|\$)/i)?.[0] || '';
  const amountToken = `${currencyPrefix}${match[1]}`;
  const amount = match[2] ? parseAmount(`${amountToken}.${match[2]}`) : parseAmount(amountToken);
  const description = match[3].trim().replace(/^(?:para\s+(?:a|o)|no|na|para|pra|pro|da|do|em|de)\s+/i, '').replace(/,+$/, '').trim();
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
  if (!categoryText) fail('Informe uma categoria depois de “categoria”.');

  let notes;
  if (noteIndex !== -1) {
    notes = categoryWords.slice(noteIndex + 1).join(' ').replace(/^[,\s]+|[?.!]+$/g, '').trim();
    if (!notes) fail('Informe uma nota depois de “notas”.');
    notes = notes.charAt(0).toLocaleUpperCase('pt-BR') + notes.slice(1);
  }

  const command = {
    type: operation,
    amount,
    description,
    category: categoryText.charAt(0).toLocaleUpperCase('pt-BR') + categoryText.slice(1),
  };
  if (notes) command.notes = notes;
  if (when) command.when = when;
  return command;
}

export function parseMessage(input) {
  const text = normalizeText(input);
  if (!text) fail('Digite uma mensagem financeira.');
  return parseCanSpendQuestion(text)
    || parseAvailableCategoryQuestion(text)
    || { kind: 'transaction', command: parseCommand(text) };
}

export function amountToCents(amount) {
  return Math.round(amount * 100);
}
