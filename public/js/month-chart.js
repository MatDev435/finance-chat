/**
 * Vertical bar chart of monthly totals, built as an HTML list so it is a
 * real, navigable structure for screen readers (TalkBack, VoiceOver, NVDA):
 * each bar is a list item with its full text ("Outubro de 2026: R$ 125,00,
 * 2 despesas"); the drawn bar and the short labels are decorative
 * (aria-hidden). The caption and the legend are plain text. Bar heights are
 * set through the CSSOM (allowed by the CSP, unlike style attributes).
 */
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const TYPE_PLURAL = { expense: 'despesas', income: 'receitas', any: 'transações' };
const TYPE_SINGULAR = { expense: 'despesa', income: 'receita', any: 'transação' };
const TITLES = { expense: 'Despesas por mês', income: 'Receitas por mês', any: 'Saldo por mês' };

const money = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
/**
 * Short label above a bar (the exact value is in the bar's text for screen
 * readers and in the legend): "R$ 7,50", "R$ 93", "R$ 1,2 mil".
 */
function compact(cents) {
  const reais = cents / 100;
  if (Math.abs(reais) >= 1000) return reais.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 });
  return reais.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: Math.abs(reais) >= 10 ? 0 : 2 });
}
const dateText = (date) => date.split('-').reverse().join('/');

function monthParts(month) {
  const [year, index] = String(month).split('-').map(Number);
  return { year, index: index - 1 };
}

const capitalized = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Display model of the chart (no DOM), or null with fewer than two months.
 * Amounts in cents; expenses and incomes are drawn as positive values, a
 * balance ("any") keeps its sign.
 */
export function chartModel(data) {
  const months = Array.isArray(data?.months) ? data.months : [];
  if (months.length < 2) return null;
  const type = TYPE_PLURAL[data.type] ? data.type : 'any';
  const value = (item) => (type === 'any' ? item.total : Math.abs(item.total));
  const max = Math.max(...months.map((item) => Math.abs(value(item))));
  const sameYear = new Set(months.map((item) => monthParts(item.month).year)).size === 1;
  // Only the first month can start after day 1 (a rolling period such as "últimos 4 meses").
  const partialFrom = data.from && !data.from.endsWith('-01') ? data.from : null;

  const bars = months.map((item, position) => {
    const { year, index } = monthParts(item.month);
    const amount = value(item);
    const label = `${capitalized(MONTHS[index])} de ${year}`;
    const partial = position === 0 ? partialFrom : null;
    const count = item.count ? `${item.count} ${item.count === 1 ? TYPE_SINGULAR[type] : TYPE_PLURAL[type]}` : `sem ${TYPE_PLURAL[type]}`;
    return {
      month: item.month,
      label,
      short: `${SHORT[index]}${sameYear ? '' : `/${String(year).slice(2)}`}${partial ? '*' : ''}`,
      valueText: money(amount),
      compactText: compact(amount),
      height: max ? Math.max(amount ? 2 : 0, Math.round((Math.abs(amount) / max) * 100)) : 0,
      negative: amount < 0,
      empty: !item.count,
      partial,
      srText: `${label}${partial ? ` (a partir de ${dateText(partial)})` : ''}: ${money(amount)}${type === 'any' && amount < 0 ? ' negativo' : ''}, ${count}.`,
    };
  });

  const highest = max ? bars[months.findIndex((item) => Math.abs(value(item)) === max)] : null;
  const total = months.reduce((sum, item) => sum + value(item), 0);
  const subject = [data.category, ...(data.payees || [])].filter(Boolean).join(', ');
  return {
    title: TITLES[type],
    summary: `Gráfico de barras com ${bars.length} meses, de ${bars[0].label} a ${bars.at(-1).label}${subject ? `, ${subject}` : ''}.`,
    bars,
    legend: [
      highest ? `Maior: ${highest.label} (${highest.valueText})` : `Nenhum valor no período`,
      `Média: ${money(Math.round(total / bars.length))} por mês`,
    ],
    note: partialFrom ? `* ${capitalized(MONTHS[monthParts(months[0].month).index])} a partir de ${dateText(partialFrom)}.` : null,
    type,
  };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The chart as a <figure>, or null when there is nothing to compare. */
export function monthChart(data) {
  const model = chartModel(data);
  if (!model) return null;
  const figure = element('figure', `month-chart chart-${model.type}`);
  const caption = element('figcaption', 'chart-caption');
  caption.append(element('span', 'chart-title', model.title), element('span', 'sr-only', ` ${model.summary}`));
  figure.append(caption);

  const scroller = element('div', 'chart-scroll');
  // Only when the bars do not fit (many months, narrow screen): a focusable region, so keyboard users can scroll it too.
  const updateScrollable = () => {
    if (!scroller.isConnected) return;
    if (scroller.scrollWidth > scroller.clientWidth + 1) {
      scroller.tabIndex = 0;
      scroller.setAttribute('role', 'region');
      scroller.setAttribute('aria-label', `${model.title}: role para os lados para ver todos os meses`);
    } else {
      scroller.removeAttribute('tabindex');
      scroller.removeAttribute('role');
      scroller.removeAttribute('aria-label');
    }
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(updateScrollable).observe(scroller);
  else requestAnimationFrame(updateScrollable);
  const list = element('ol', 'chart-bars');
  list.setAttribute('role', 'list'); // keeps list semantics in Safari/VoiceOver with list-style: none
  for (const bar of model.bars) {
    const item = element('li', `chart-item${bar.empty ? ' is-empty' : ''}${bar.negative ? ' is-negative' : ''}${bar.partial ? ' is-partial' : ''}`);
    const value = element('span', 'chart-value', bar.compactText);
    const track = element('span', 'chart-track');
    const fill = element('span', 'chart-bar');
    fill.style.height = `${bar.height}%`;
    track.append(fill);
    const label = element('span', 'chart-label', bar.short);
    for (const decorative of [value, track, label]) decorative.setAttribute('aria-hidden', 'true');
    item.append(element('span', 'sr-only', bar.srText), value, track, label);
    list.append(item);
  }
  scroller.append(list);
  figure.append(scroller);

  const legend = element('p', 'chart-legend');
  const swatch = element('span', 'chart-swatch');
  swatch.setAttribute('aria-hidden', 'true');
  legend.append(swatch, element('span', '', model.legend.join(' · ')));
  figure.append(legend);
  if (model.note) figure.append(element('p', 'chart-note', model.note));
  return figure;
}
