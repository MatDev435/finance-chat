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

export const BATCH_UNDO_NOTE = 'Lotes não podem ser desfeitos pelo Finance Chat. Se precisar, apague as movimentações direto no Actual Budget.';

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

export function batchResultText(previews, { results, synced, account }) {
  const lines = previews.map((preview, index) => `${RESULT_MARKS[results[index]]}: ${summaryText(preview)} · ${shortCategory(preview)}`);
  const written = results.filter((result) => result === 'written').length;
  if (results.every((result) => result === 'written')) {
    const head = synced
      ? `${written} movimentações registradas com sucesso na conta ${account.name}!`
      : `${written} movimentações registradas na conta ${account.name}, mas a sincronização com o servidor Actual falhou. Elas serão enviadas na próxima sincronização. Não envie de novo.`;
    return `${head}\n\n${lines.join('\n')}\n\n${BATCH_UNDO_NOTE}`;
  }
  return `O lote foi interrompido por uma falha ao gravar no Actual Budget.\n\n${lines.join('\n')}\n\nVerifique no Actual Budget a movimentação com resultado incerto antes de enviar de novo. Não reenvie as que foram registradas; as não registradas podem ser enviadas em uma nova mensagem.${synced ? '' : '\nA sincronização também falhou: o que foi registrado será enviado na próxima sincronização.'}`;
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
export const UNSUPPORTED_NOTICE = 'Isso eu não consigo fazer pelo Finance Chat. Posso registrar despesas e receitas (inclusive várias de uma vez ou divididas entre categorias), consultar o saldo das categorias, simular compras e buscar transações desta conta.';
export const NOT_UNDERSTOOD = 'Não entendi a mensagem. Você pode registrar despesas e receitas, consultar o saldo de uma categoria, simular uma compra ou buscar transações desta conta.';
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
