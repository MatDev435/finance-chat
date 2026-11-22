/** History-safe display data of API responses, shared by the chat and the quick window. */

export const PREVIEW_TEXT = 'Entendi! Encontrei uma movimentação. Confira os detalhes antes de confirmar.';

export function batchText(count) {
  return `Entendi! Encontrei ${count} movimentações. Confira todas antes de aprovar.`;
}

/** Display data of one transaction preview (history-safe fields only). */
export function previewData(preview) {
  return {
    type: preview.command.type, amount: preview.command.amount, description: preview.command.description,
    category: preview.category?.name ?? '', account: preview.account.name, date: preview.transaction.date, notes: preview.command.notes,
    parts: preview.splits?.map((split) => ({ category: split.category.name, amount: split.amount })),
  };
}

export function batchData(data) {
  const items = data.items.map((preview) => ({ ...previewData(preview), category: preview.category?.name ?? null }));
  const total = (type) => items.filter((item) => item.type === type).reduce((sum, item) => sum + Math.round(item.amount * 100), 0) / 100;
  return { items, expenses: total('expense'), incomes: total('income'), account: data.account?.name ?? '' };
}

/** The bubble text of a search: month-by-month answers keep only the total sentence (the card lists the months). */
export function searchBubbleText(data) {
  return data.search?.result === 'by_month' ? String(data.message).split('\n')[0].replace(/ Por mês:$/, '') : data.message;
}

/** The bubble text of a month summary: the heading line (the card shows every number). */
export function summaryBubbleText(data) {
  return String(data.message).split('\n')[0];
}
