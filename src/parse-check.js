/**
 * Conservative completeness check for the hybrid mode (AI enabled).
 *
 * The deterministic parser is anchored and greedy: everything after
 * "categoria" becomes the category, and everything between the amount and
 * "categoria" becomes the description. A message with two operations can
 * therefore still "parse", with the second operation swallowed by a free-text
 * field:
 *
 *   "Gastei 50 no McDonald's categoria alimentação e 30 no mercado"
 *     → category "Alimentação e 30 no mercado"
 *
 * Without AI that is harmless (the category does not exist and the message is
 * refused). With AI enabled, a parse is accepted only when no free-text field
 * looks like it carries another amount, another operation or a question.
 * Anything doubtful goes, whole, to the AI. A false alarm only costs one AI
 * call; accepting a partial parse would silently drop an operation.
 *
 * The second half of the check (the category must match the budget exactly)
 * needs the budget and is done by the chat dispatcher.
 */

const WORD = (words) => new RegExp(String.raw`(?<![\p{L}\d])(?:${words.join('|')})(?![\p{L}\d])`, 'iu');

const DIGIT = /\d/;
const MONEY = /(?:r\$|\$)|(?<![\p{L}])(?:reais|real|centavos?)(?![\p{L}])/iu;
const OPERATION = WORD([
  'gastei', 'gastar', 'gasto', 'comprei', 'comprar', 'paguei', 'pagar', 'mandei', 'recebi', 'receber', 'ganhei',
  'transferi', 'depositei', 'saquei', 'registra', 'registre', 'registrar', 'lança', 'lance', 'lançar', 'lancar',
  'anota', 'anote', 'anotar',
]);
const QUESTION = WORD(['quanto', 'quanta', 'quantos', 'quantas', 'quando', 'qual', 'quais', 'posso', 'sobra', 'sobrou', 'sobraria']);
// "no McDonald's e no mercado": a conjunction followed by a preposition introduces another place or operation.
// "Pão e Cia" or "Casa e jardim" stay accepted.
const SECOND_PLACE = WORD([String.raw`e\s+(?:no|na|nos|nas|em|de|do|da|pro|pra|para)`]);

function suspiciousName(value) {
  if (typeof value !== 'string') return false;
  return DIGIT.test(value) || MONEY.test(value) || OPERATION.test(value) || QUESTION.test(value) || SECOND_PLACE.test(value);
}

function suspiciousNotes(value) {
  if (typeof value !== 'string') return false;
  // Notes may contain numbers ("parcela 3 de 10"), but not money or another operation.
  return MONEY.test(value) || OPERATION.test(value);
}

/**
 * Returns { complete: true } when the parsed intent can be trusted as the
 * whole message, or { complete: false, reason } (reason is a short code for
 * tests; it never contains message text).
 */
export function isCompleteParse(intent) {
  if (!intent || typeof intent !== 'object') return { complete: false, reason: 'no-intent' };
  if (intent.kind === 'undo' || intent.kind === 'summary') return { complete: true };

  if (intent.kind === 'search') {
    return suspiciousName(intent.search?.term) ? { complete: false, reason: 'search-term' } : { complete: true };
  }

  if (intent.kind === 'category-available' || intent.kind === 'category-can-spend') {
    return suspiciousName(intent.category) ? { complete: false, reason: 'category' } : { complete: true };
  }

  if (intent.kind === 'transaction') {
    const { command } = intent;
    if (!command) return { complete: false, reason: 'no-command' };
    if (suspiciousName(command.description)) return { complete: false, reason: 'description' };
    if (command.splits) {
      if (command.splits.some((split) => suspiciousName(split.category))) return { complete: false, reason: 'split-category' };
    } else if (suspiciousName(command.category)) {
      return { complete: false, reason: 'category' };
    }
    if (suspiciousNotes(command.notes)) return { complete: false, reason: 'notes' };
    return { complete: true };
  }

  return { complete: false, reason: 'unknown-kind' };
}
