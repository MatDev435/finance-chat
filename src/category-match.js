/**
 * Deterministic category matching (no AI):
 * 1. same name ignoring case and extra spaces (original behavior);
 * 2. same letters ignoring accents, only when exactly one category matches;
 * 3. otherwise, up to 3 suggestions ranked by edit distance (Levenshtein),
 *    with prefix/substring matches favored. Hidden categories are never suggested.
 */
const MAX_SUGGESTIONS = 3;

function normalizeName(value) {
  return String(value).trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
}

export function foldName(value) {
  return normalizeName(value).normalize('NFD').replace(/\p{M}/gu, '');
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

export function suggestCategories(categories, requested, { exclude = [] } = {}) {
  const target = foldName(requested);
  if (!target) return [];
  const threshold = Math.max(2, Math.floor(target.length / 3));
  const scored = [];
  for (const category of categories) {
    if (category.hidden || exclude.includes(category.id)) continue;
    const name = foldName(category.name);
    let score = levenshtein(target, name);
    if (target.length >= 3 && (name.startsWith(target) || target.startsWith(name))) score = Math.min(score, 1);
    else if (target.length >= 4 && name.includes(target)) score = Math.min(score, 2);
    if (score <= threshold) scored.push({ score, category });
  }
  scored.sort((x, y) => x.score - y.score || x.category.name.localeCompare(y.category.name, 'pt-BR'));
  return scored.slice(0, MAX_SUGGESTIONS).map(({ category }) => ({ id: category.id, name: category.name }));
}

/** Returns { category } when there is exactly one match, otherwise { category: null, suggestions }. */
export function matchCategory(categories, requested) {
  const exact = categories.find((item) => normalizeName(item.name) === normalizeName(requested));
  if (exact) return { category: exact };
  const folded = foldName(requested);
  const sameLetters = categories.filter((item) => foldName(item.name) === folded);
  if (sameLetters.length === 1) return { category: sameLetters[0] };
  const ambiguous = sameLetters.map(({ id, name }) => ({ id, name }));
  const others = suggestCategories(categories, requested, { exclude: ambiguous.map((item) => item.id) });
  return { category: null, suggestions: [...ambiguous, ...others].slice(0, MAX_SUGGESTIONS) };
}

/** "A categoria 'X' não existe no Actual Budget. Você quis dizer: A ou B?" */
export function notFoundMessage(requested, suggestions) {
  const hint = suggestions.length ? ` Você quis dizer: ${suggestions.map((item) => item.name).join(' ou ')}?` : '';
  return `A categoria '${requested}' não existe no Actual Budget.${hint}`;
}
