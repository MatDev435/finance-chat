/** Pure formatting for the AI settings (no DOM), shared with the tests. */

/**
 * Cost in nano-dollars (1e-9 USD, as stored by the server) → "US$ 0,0248".
 * Small amounts keep about three significant digits instead of rounding to US$ 0,00.
 */
export function formatUsd(nano) {
  const value = Number(nano) || 0;
  if (value <= 0) return 'US$ 0,00';
  const usd = value / 1e9;
  const digits = Math.min(9, Math.max(2, Math.ceil(-Math.log10(usd)) + 2));
  return `US$ ${usd.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
}

export function formatTokens(count) {
  return `${(Number(count) || 0).toLocaleString('pt-BR')} token${count === 1 ? '' : 's'}`;
}

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export function monthLabel(month) {
  const [year, index] = String(month || '').split('-').map(Number);
  return MONTHS[index - 1] ? `${MONTHS[index - 1]}/${year}` : '';
}

/** Rows (label, value) for the usage summary of one period. */
export function usageRows(totals) {
  if (!totals?.requests) return [['Chamadas', 'nenhuma ainda']];
  const rows = [
    ['Chamadas', String(totals.requests)],
    ['Tokens de entrada', formatTokens(totals.inputTokens) + (totals.cachedInputTokens ? ` (${formatTokens(totals.cachedInputTokens)} em cache)` : '')],
    ['Tokens de saída', formatTokens(totals.outputTokens) + (totals.reasoningTokens ? ` (${formatTokens(totals.reasoningTokens)} de raciocínio)` : '')],
    ['Total de tokens', formatTokens(totals.totalTokens)],
    ['Custo estimado', formatUsd(totals.costNanoUsd)],
  ];
  const notes = [];
  if (totals.requestsWithoutUsage) notes.push(`${totals.requestsWithoutUsage} sem dados de uso (sem resposta da OpenAI)`);
  if (totals.requestsWithoutCost) notes.push(`${totals.requestsWithoutCost} sem preço conhecido, fora da estimativa`);
  if (notes.length) rows.push(['Observações', notes.join('; ')]);
  return rows;
}

/** "3 áudios · 0:42 · US$ 0,0032" (voice transcriptions of the desktop app). */
export function transcriptionText(totals) {
  if (!totals?.requests) return 'nenhuma ainda';
  const seconds = Math.round((totals.audioMs || 0) / 1000);
  const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return `${totals.requests} ${totals.requests === 1 ? 'áudio' : 'áudios'} · ${duration} · ${formatUsd(totals.costNanoUsd)}`;
}

/** "GPT-6 Luna · US$ 0.10 / US$ 0.50 por 1M tokens (entrada / saída)". */
export function modelHint(model) {
  if (!model) return '';
  const prices = model.prices ? ` Preço: US$ ${model.prices.input.replace('.', ',')} por 1M tokens de entrada e US$ ${model.prices.output.replace('.', ',')} por 1M de saída.` : '';
  return `${model.description}.${prices}`;
}
