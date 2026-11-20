/**
 * Every text the chat shows, built by deterministic templates from validated
 * data (never written by the model). Values in reais unless noted.
 */
import { currentLocalDate } from './transaction-mapping.js';

export function moneyText(amount) {
  return amount.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export const centsText = (cents) => moneyText(cents / 100);

export function typeText(type) {
  return type === 'expense' ? 'Despesa' : 'Receita';
}

export function dateText(date) {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

const payeeText = (description) => description || 'sem beneficiário';

/** "Categoria: Alimentação" or, for a split, "Categorias: Alimentação (R$ 70,00), Limpeza (R$ 30,00)". */
export function categoryText({ category, splits }) {
  if (splits) return `Categorias: ${splits.map((split) => `${split.category.name} (${moneyText(split.amount)})`).join(', ')}`;
  return `Categoria: ${category.name}`;
}

export function previewText(command, validation, date) {
  const noteLine = command.notes ? `\nNota: ${command.notes}` : '';
  return `Vou registrar esta movimentação:\n\nTipo: ${typeText(command.type)}\nValor: ${moneyText(command.amount)}\nBeneficiário: ${payeeText(command.description)}\nConta: ${validation.account.name}\n${categoryText(validation)}\nData: ${dateText(date)}${noteLine}\n\nDeseja confirmar?`;
}

export function successText(preview, account) {
  // The date is mentioned only when it is not today, keeping the usual message unchanged.
  const date = preview.transaction.date;
  const dateLine = date !== currentLocalDate() ? `\nData: ${dateText(date)}.` : '';
  return `Movimentação registrada com sucesso!\n\n${summaryText(preview)}.\nConta: ${account.name}.\n${categoryText(preview)}.${dateLine}`;
}

/** "Despesa de R$ 40,00 para mercado" */
export function summaryText(preview) {
  const payee = preview.command.description ? ` para ${preview.command.description}` : '';
  return `${typeText(preview.command.type)} de ${moneyText(preview.command.amount)}${payee}`;
}

export function unsyncedText(preview, account) {
  return `Movimentação registrada, mas a sincronização com o servidor Actual falhou.\n\n${summaryText(preview)} na conta ${account.name}.\nEla será enviada na próxima sincronização. Não envie de novo.`;
}

/* ---------- Batches ---------- */

export const BATCH_UNDO_NOTE = 'Depois de registrado, o lote inteiro pode ser desfeito por 10 minutos.';
const BATCH_UNDO_AVAILABLE = 'Para desfazer o lote inteiro, use o botão ↶ Desfazer ou digite “desfazer” (por 10 minutos).';
const BATCH_NOT_UNDOABLE = 'Não consegui identificar com segurança as movimentações criadas, então este lote não pode ser desfeito pelo Finance Chat. Se precisar, apague-as direto no Actual Budget.';

function shortCategory(preview) {
  return preview.splits ? preview.splits.map((split) => split.category.name).join(' + ') : preview.category.name;
}

function batchLine(preview, index) {
  return `${index + 1}. ${summaryText(preview)} · ${shortCategory(preview)} · ${dateText(preview.transaction.date)}`;
}

function totalsText(previews) {
  const sum = (type) => previews.filter((preview) => preview.command.type === type).reduce((total, preview) => total + Math.round(preview.command.amount * 100), 0);
  const lines = [];
  const expenses = sum('expense');
  const incomes = sum('income');
  if (expenses) lines.push(`Total de despesas: ${centsText(expenses)}`);
  if (incomes) lines.push(`Total de receitas: ${centsText(incomes)}`);
  return lines.join('\n');
}

export function batchPreviewText(previews, account) {
  return `Vou registrar ${previews.length} movimentações na conta ${account.name}:\n\n${previews.map(batchLine).join('\n')}\n\n${totalsText(previews)}\n\n${BATCH_UNDO_NOTE}\n\nDeseja confirmar todas?`;
}

const RESULT_MARKS = { written: '✓ Registrada', uncertain: '? Resultado incerto', skipped: '✗ Não registrada' };

export function batchResultText(previews, { results, synced, account }, { undoable = false } = {}) {
  const lines = previews.map((preview, index) => `${RESULT_MARKS[results[index]]}: ${summaryText(preview)} · ${shortCategory(preview)}`);
  const written = results.filter((result) => result === 'written').length;
  if (results.every((result) => result === 'written')) {
    const head = synced
      ? `${written} movimentações registradas com sucesso na conta ${account.name}!`
      : `${written} movimentações registradas na conta ${account.name}, mas a sincronização com o servidor Actual falhou. Elas serão enviadas na próxima sincronização. Não envie de novo.`;
    return `${head}\n\n${lines.join('\n')}\n\n${undoable ? BATCH_UNDO_AVAILABLE : BATCH_NOT_UNDOABLE}`;
  }
  return `O lote foi interrompido por uma falha ao gravar no Actual Budget.\n\n${lines.join('\n')}\n\nVerifique no Actual Budget a movimentação com resultado incerto antes de enviar de novo. Não reenvie as que foram registradas; as não registradas podem ser enviadas em uma nova mensagem.${synced ? '' : '\nA sincronização também falhou: o que foi registrado será enviado na próxima sincronização.'}`;
}

/** The answer to undoing a whole batch. */
export function batchUndoneText(entry, synced) {
  const list = entry.summaries.map((summary) => `• ${summary}`).join('\n');
  const head = `Lote desfeito: ${entry.transactions.length} movimentações apagadas.`;
  return synced
    ? `${head}\n\n${list}`
    : `${head.replace('apagadas.', 'apagadas na cópia local')}, mas a sincronização com o servidor Actual falhou. Elas serão removidas do servidor na próxima sincronização.\n\n${list}`;
}

/* ---------- Clarifications (AI drafts) ---------- */

function itemName(item, number, total) {
  const name = item.description || (total > 1 ? `movimentação ${number}` : 'movimentação');
  return item.amount === null ? name : `${name} (${moneyText(item.amount)})`;
}

/** "Categoria de Farmácia (R$ 20,00)", "Valor da parte 2 (Livre) de Mercado". */
export function missingLabel(missing, items) {
  const item = items[missing.item - 1];
  const name = itemName(item, missing.item, items.length);
  if (missing.part) {
    const part = item.splits[missing.part - 1];
    const partName = missing.field === 'amount' ? (part.category.id ? ` (${part.category.name})` : '') : (part.amount === null ? '' : ` (${moneyText(part.amount)})`);
    return `${missing.field === 'amount' ? 'Valor' : 'Categoria'} da parte ${missing.part}${partName} de ${name}`;
  }
  return `${missing.field === 'amount' ? 'Valor' : 'Categoria'} de ${name}`;
}

function missingLine(missing, items) {
  const base = `• ${missingLabel(missing, items)}`;
  if (missing.field !== 'category') return `${base}?`;
  if (missing.typed) {
    const hint = missing.suggestions.length ? ` Você quis dizer: ${missing.suggestions.map((item) => item.name).join(' ou ')}?` : '';
    return `${base}: a categoria “${missing.typed}” não existe no Actual Budget.${hint}`;
  }
  const hint = missing.suggestions.length ? ` Sugestões: ${missing.suggestions.map((item) => item.name).join(', ')}.` : '';
  return `${base}?${hint}`;
}

export function clarifyText(missing, items, { ignored = false } = {}) {
  const intro = ignored
    ? 'Não consegui usar essa resposta para completar as movimentações. Ainda falta:'
    : `Antes de preparar a prévia, preciso de ${missing.length === 1 ? 'mais uma informação' : 'mais algumas informações'}:`;
  const tail = missing.some((item) => item.field === 'category')
    ? 'Escolha uma categoria abaixo ou responda aqui no chat. Nada foi registrado ainda.'
    : 'Responda aqui no chat. Nada foi registrado ainda.';
  return `${intro}\n\n${missing.map((item) => missingLine(item, items)).join('\n')}\n\n${tail}`;
}

/* ---------- AI notices ---------- */

export const MIXED_NOTICE = 'Não registrei nenhuma movimentação: quando uma mensagem mistura perguntas e lançamentos, só as perguntas são respondidas. Para registrar, envie o lançamento em uma nova mensagem.';
export const UNDO_NOTICE = 'Para desfazer a última movimentação desta conversa, digite “desfazer” ou use o botão ↶ Desfazer. A IA não apaga movimentações.';
export const UNSUPPORTED_NOTICE = 'Isso eu não consigo fazer pelo Finance Chat. Posso registrar despesas e receitas (inclusive várias de uma vez ou divididas entre categorias), consultar o saldo das categorias, simular compras, buscar transações desta conta e mostrar o resumo do mês.';
export const NOT_UNDERSTOOD = 'Não entendi a mensagem. Você pode registrar despesas e receitas, consultar o saldo de uma categoria, simular uma compra, buscar transações desta conta ou pedir o resumo do mês.';
export const TOO_MANY_QUERIES_NOTICE = 'Respondi às três primeiras perguntas. Envie as outras em uma nova mensagem.';
export const DRAFT_DISCARDED = 'Pronto, descartei as movimentações incompletas. Nada foi registrado.';

/* ---------- Category balance ---------- */

export function availabilityText(categoryName, availableCents) {
  return `Você tem ${centsText(availableCents)} disponíveis em ${categoryName} este mês.`;
}

export function spendingText(categoryName, spending) {
  return spending.canSpend
    ? `Sim, você pode gastar esse valor em ${categoryName}.`
    : `Não, você não tem saldo suficiente para esse gasto em ${categoryName}.`;
}

/* ---------- Transaction search ---------- */

const TYPE_WORDS = { expense: ['despesa', 'despesas'], income: ['receita', 'receitas'], any: ['transação', 'transações'] };
const ORDER_WORDS = { newest: 'mais recentes', oldest: 'mais antigas', largest: 'maiores', smallest: 'menores' };

export function periodText({ from, to }) {
  if (!from) return 'em todo o histórico';
  if (from === to) return `em ${dateText(from)}`;
  return `de ${dateText(from)} a ${dateText(to)}`;
}

/** " com McDonald's com “lanche” nas notas em Alimentação entre R$ 10,00 e R$ 50,00" */
export function searchFiltersText({ type, payees, notes, category, minAmount, maxAmount }) {
  let filters = '';
  if (payees?.length) filters += ` ${type === 'income' ? 'de' : 'com'} ${payees.join(', ')}`;
  if (notes) filters += ` com “${notes}” nas notas`;
  if (category) filters += ` em ${category}`;
  if (minAmount !== null && maxAmount !== null) filters += ` entre ${moneyText(minAmount)} e ${moneyText(maxAmount)}`;
  else if (minAmount !== null) filters += ` a partir de ${moneyText(minAmount)}`;
  else if (maxAmount !== null) filters += ` de até ${moneyText(maxAmount)}`;
  return filters;
}

function transactionText(transaction, view) {
  // The payee is not repeated when the search was already about that payee only.
  const known = view.payees?.length === 1 && view.payees[0] === transaction.payee;
  const payee = transaction.payee && !known ? `, com ${transaction.payee}` : '';
  const category = transaction.category ? ` (${transaction.category})` : '';
  return `${centsText(Math.abs(transaction.amount))} em ${dateText(transaction.date)}${payee}${category}`;
}

/** The answer to a search, from the numbers the backend computed. */
export function searchText(view) {
  // No payee had that name, so the term was looked up in the notes instead.
  const lead = view.payeeAsNotes ? `Não encontrei um beneficiário chamado “${view.notes}”, então procurei nas notas das transações. ` : '';
  return lead + searchAnswer(view);
}

/** "agosto de 2026: R$ 120,00 (3 despesas)" lines after the total of the whole period. */
function monthlyAnswer(view) {
  const [one, many] = TYPE_WORDS[view.type] || TYPE_WORDS.any;
  const head = view.count === 0 ? searchAnswer({ ...view, result: 'sum' }) : `${searchAnswer({ ...view, result: 'sum' })} Por mês:`;
  const value = (total) => (view.type === 'any' ? centsText(total) : centsText(Math.abs(total)));
  const lines = view.months.map((item) => `• ${monthName(item.month)}: ${value(item.total)}${item.count ? ` (${item.count} ${item.count === 1 ? one : many})` : ''}`);
  const note = view.truncated ? `\n\nMostrei só os últimos ${view.months.length} meses.` : '';
  return `${head}\n\n${lines.join('\n')}${note}`;
}

function searchAnswer(view) {
  if (view.result === 'by_month' && view.months) return monthlyAnswer(view);
  const [one, many] = TYPE_WORDS[view.type] || TYPE_WORDS.any;
  const filters = searchFiltersText(view);
  const period = periodText(view);
  const counted = `${view.count} ${view.count === 1 ? one : many}`;
  if (view.count === 0) return `Não encontrei ${many}${filters} nesta conta ${period}.`;

  if (view.result === 'sum' || view.result === 'count') {
    const absolute = centsText(Math.abs(view.total));
    if (view.result === 'count') {
      return view.type === 'any'
        ? `Encontrei ${counted}${filters} ${period}. Saldo delas: ${centsText(view.total)}.`
        : `Encontrei ${counted}${filters} ${period}, somando ${absolute}.`;
    }
    if (view.type === 'expense') return `Você gastou ${absolute}${filters} ${period} (${counted}).`;
    if (view.type === 'income') return `Você recebeu ${absolute}${filters} ${period} (${counted}).`;
    return `O saldo das transações${filters} ${period} é ${centsText(view.total)} (${counted}).`;
  }

  const [first] = view.transactions;
  if (view.result === 'max' || view.result === 'min') {
    return `A ${view.result === 'max' ? 'maior' : 'menor'} ${one}${filters} ${period} foi de ${transactionText(first, view)}.`;
  }
  if (view.limit === 1 && (view.order === 'newest' || view.order === 'oldest')) {
    return `A ${view.order === 'newest' ? 'última' : 'primeira'} ${one}${filters} ${view.from ? `${period} ` : ''}foi de ${transactionText(first, view)}.`;
  }
  const shown = view.transactions.length;
  const more = view.count > shown ? ` Estas são as ${shown} ${ORDER_WORDS[view.order] || ORDER_WORDS.newest}:` : '';
  return `Encontrei ${counted}${filters} ${period}.${more}`;
}

/* ---------- Month summary ---------- */

const MONTH_NAMES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** "2026-11" → "novembro de 2026" */
export function monthName(month) {
  const [year, index] = month.split('-').map(Number);
  return `${MONTH_NAMES[index - 1]} de ${year}`;
}

const count = (value, one, many) => `${value} ${value === 1 ? one : many}`;
const signedCents = (cents) => `${cents < 0 ? '−' : '+'}${centsText(Math.abs(cents))}`;

function topExpenseText(expense) {
  const payee = expense.payee ? ` com ${expense.payee}` : '';
  return `${centsText(Math.abs(expense.amount))}${payee} em ${dateText(expense.date)}`;
}

/** The summary card's text, from the numbers the backend computed (cents). */
export function monthSummaryText(view) {
  const lines = [`Resumo de ${monthName(view.month)} (${dateText(view.from)} a ${dateText(view.to)}).`, '', `Na conta ${view.account}:`];
  if (!view.expenseCount && !view.incomeCount) {
    lines.push('• Nenhuma despesa ou receita no período.');
  } else {
    lines.push(
      `• Despesas: ${centsText(view.expenses)} (${count(view.expenseCount, 'lançamento', 'lançamentos')})`,
      `• Receitas: ${centsText(view.incomes)} (${count(view.incomeCount, 'lançamento', 'lançamentos')})`,
      `• Resultado: ${signedCents(view.net)}`,
    );
    if (view.topExpenses.length) lines.push(`• Maiores despesas: ${view.topExpenses.map(topExpenseText).join('; ')}`);
  }
  lines.push('');
  if (!view.budget) {
    lines.push('O orçamento não tem dados deste mês.');
    return lines.join('\n');
  }
  const { budget } = view;
  lines.push('No orçamento do mês (todas as contas):', `• Gasto: ${centsText(budget.spent)} de ${centsText(budget.budgeted)} orçados`);
  if (budget.topCategories.length) lines.push(`• Onde mais gastou: ${budget.topCategories.map((category) => `${category.name} (${centsText(category.spent)})`).join(', ')}`);
  if (budget.overspentCount) {
    const more = budget.overspentCount > budget.overspent.length ? ` e mais ${budget.overspentCount - budget.overspent.length}` : '';
    lines.push(`• Categorias estouradas: ${budget.overspent.map((category) => `${category.name} (faltam ${centsText(-category.balance)})`).join(', ')}${more}`);
  } else {
    lines.push('• Nenhuma categoria estourada.');
  }
  return lines.join('\n');
}
