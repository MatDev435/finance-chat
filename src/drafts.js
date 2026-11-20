/**
 * Transactions interpreted by the AI, before they become a preview. Pure
 * functions over plain data: no budget access, no writes.
 *
 * Category rule: a category is used only when the user typed one that matches
 * the budget (same rules as the parser: exact name, or the only one with the
 * same letters ignoring accents) or picked/confirmed one. The model's
 * categoryHints only ever become suggestions shown to the user.
 */
import { matchCategory } from './category-match.js';
import { MAX_SPLITS, checkSplitTotal } from './parser.js';

function fail(message) {
  const error = new Error(message);
  error.code = 'INVALID_COMMAND';
  throw error;
}

const slot = (name) => ({ name: name ?? null, id: null, suggestions: [] });
const resolved = (category) => ({ name: category.name, id: category.id, suggestions: [] });
const brief = ({ id, name }) => ({ id, name });

/** Plan transactions (plan.js) → draft items with unresolved category slots. */
export function draftItemsFrom(planItems) {
  return planItems.map((item) => ({
    type: item.type,
    amount: item.amount,
    description: item.description,
    notes: item.notes,
    when: item.when,
    hints: item.hints,
    category: item.splits ? null : slot(item.category),
    splits: item.splits ? item.splits.map((part) => ({ amount: part.amount, category: slot(part.category) })) : null,
  }));
}

/** Up to 3 suggestions from the model's hints, matched against visible budget categories. */
function hintSuggestions(categories, hints) {
  const visible = categories.filter((category) => !category.hidden);
  const found = new Map();
  for (const hint of hints || []) {
    const match = matchCategory(visible, hint);
    for (const category of match.category ? [match.category] : match.suggestions) if (!found.has(category.id)) found.set(category.id, brief(category));
  }
  return [...found.values()].slice(0, 3);
}

function resolveSlot(current, categories, hints) {
  if (current.id) {
    const still = categories.find((category) => category.id === current.id);
    // Deleted in Actual meanwhile: ask again instead of guessing another one.
    return still ? resolved(still) : { name: current.name, id: null, suggestions: [] };
  }
  if (!current.name) return { name: null, id: null, suggestions: hintSuggestions(categories, hints) };
  const match = matchCategory(categories, current.name);
  return match.category ? resolved(match.category) : { name: current.name, id: null, suggestions: match.suggestions };
}

/** Resolves every category slot against the budget categories. */
export function resolveItems(items, categories) {
  return items.map((item) => ({
    ...item,
    category: item.category ? resolveSlot(item.category, categories, item.hints) : null,
    splits: item.splits ? item.splits.map((part) => ({ ...part, category: resolveSlot(part.category, categories, item.hints) })) : null,
  }));
}

const label = (item, index) => `${item.description || `movimentação ${index + 1}`}`;

/**
 * Split rules, the same as the parser's: 2 to 10 parts that add up exactly to
 * the total. A missing total is the sum of the parts when every part has an
 * amount (the user gave them); a mismatch is refused, never adjusted.
 */
export function checkItems(items) {
  items.forEach((item, index) => {
    if (!item.splits) return;
    const prefix = items.length > 1 ? `${label(item, index)}: ` : '';
    if (item.splits.length < 2) fail(`${prefix}Uma compra dividida precisa de pelo menos duas partes, cada uma com valor e categoria.`);
    if (item.splits.length > MAX_SPLITS) fail(`${prefix}Divida a movimentação em no máximo ${MAX_SPLITS} partes.`);
    const amounts = item.splits.map((part) => part.amount);
    if (amounts.some((amount) => amount === null)) return;
    if (item.amount === null) {
      item.amount = Math.round(amounts.reduce((sum, amount) => sum + amount * 100, 0)) / 100;
      return;
    }
    try {
      checkSplitTotal(item.splits, item.amount);
    } catch (error) {
      error.message = `${prefix}${error.message} Envie a mensagem novamente com os valores corretos.`;
      throw error;
    }
  });
  return items;
}

/** What is still missing, in order: [{ item, part, field, typed, suggestions }] (1-based numbers). */
export function missingFields(items) {
  const missing = [];
  items.forEach((item, index) => {
    const number = index + 1;
    if (item.amount === null && !item.splits) missing.push({ item: number, part: null, field: 'amount' });
    if (item.category && !item.category.id) missing.push({ item: number, part: null, field: 'category', typed: item.category.name, suggestions: item.category.suggestions });
    item.splits?.forEach((part, partIndex) => {
      if (part.amount === null) missing.push({ item: number, part: partIndex + 1, field: 'amount' });
      if (!part.category.id) missing.push({ item: number, part: partIndex + 1, field: 'category', typed: part.category.name, suggestions: part.category.suggestions });
    });
  });
  return missing;
}

/**
 * Fills missing data. Only fields that are still missing can be set: an update
 * can never change an amount or a category that was already known. An update
 * carries either a typed value or, for a category picked on screen, its id.
 * Returns { items, applied } (applied = updates that targeted a missing field).
 */
export function applyUpdates(items, updates, categories) {
  const next = structuredClone(items);
  let applied = 0;
  for (const update of updates) {
    const item = next[update.item - 1];
    if (!item) continue;
    const part = update.part ? item.splits?.[update.part - 1] : null;
    if (update.part && !part) continue;
    if (update.field === 'amount') {
      const target = part || (item.splits ? null : item);
      if (!target || target.amount !== null || typeof update.value !== 'number') continue;
      target.amount = update.value;
      applied += 1;
      continue;
    }
    const current = part ? part.category : item.category;
    if (!current || current.id) continue;
    if (update.categoryId) {
      const chosen = categories.find((category) => category.id === update.categoryId);
      if (!chosen) {
        const error = new Error('A categoria escolhida não existe mais no Actual Budget. Escolha outra.');
        error.code = 'VALIDATION_ERROR';
        throw error;
      }
      Object.assign(current, resolved(chosen));
    } else {
      const match = matchCategory(categories, update.value);
      Object.assign(current, match.category ? resolved(match.category) : { name: update.value, id: null, suggestions: match.suggestions });
    }
    applied += 1;
  }
  return { items: next, applied };
}

/** A complete item as a parser-compatible command, with the resolved category ids. */
export function toCommand(item) {
  const command = { type: item.type, amount: item.amount, description: item.description };
  if (item.splits) command.splits = item.splits.map((part) => ({ amount: part.amount, category: part.category.name, categoryId: part.category.id }));
  else Object.assign(command, { category: item.category.name, categoryId: item.category.id });
  if (item.notes) command.notes = item.notes;
  if (item.when) command.when = item.when;
  return command;
}

const amountText = (amount) => (amount === null ? null : amount.toFixed(2));
const knownCategory = (current) => (current?.id ? current.name : null);

/** The draft as the model sees it: numbered items, known values and what is missing. Compact on purpose. */
export function draftContext(items) {
  return items.map((item, index) => ({
    item: index + 1,
    type: item.type,
    amount: amountText(item.amount),
    payee: item.description,
    category: item.splits ? null : knownCategory(item.category),
    splits: item.splits ? item.splits.map((part, partIndex) => ({ part: partIndex + 1, amount: amountText(part.amount), category: knownCategory(part.category) })) : null,
    missing: missingFields([item]).map(({ part, field }) => (part ? `part ${part} ${field}` : field)),
  }));
}

/** Display data for the clarification card (names and amounts only, no ids except suggestions). */
export function itemSummaries(items) {
  return items.map((item, index) => ({
    item: index + 1,
    type: item.type,
    amount: item.amount,
    description: item.description,
    category: item.category ? knownCategory(item.category) : null,
    parts: item.splits ? item.splits.map((part) => ({ amount: part.amount, category: knownCategory(part.category) })) : null,
  }));
}

/** Visible categories for the "other category" picker, sorted by name. */
export function pickerCategories(categories) {
  return categories.filter((category) => !category.hidden).map(brief).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}
