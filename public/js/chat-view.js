/** DOM rendering for one conversation. Text always goes through textContent. */

export const icons = {
  expense: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h2l2 11h10l2-8H7"/><circle cx="10" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/></svg>',
  income: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14v12H5z"/><path d="M8 7V5h8v2M12 11v5M9.5 13.5 12 16l2.5-2.5"/></svg>',
  category: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h6l2 3h8v11H4z"/><path d="M7 13h6M7 16h4"/></svg>',
  payee: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v13H4zM7 7V4h10v3M8 11h8M8 15h5"/></svg>',
  account: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/></svg>',
  date: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/></svg>',
  batch: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="5" rx="1.5"/><rect x="4" y="10.5" width="16" height="5" rx="1.5"/><path d="M4 18.5h16"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/></svg>',
  question: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01"/></svg>',
  summary: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16"/><path d="M7 16v-5M12 16V6M17 16v-8"/></svg>',
  notes: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l3 3v15H6z"/><path d="M9 10h6M9 14h6M9 18h3"/></svg>',
  alert: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 3 20h18z"/><path d="M12 10v4M12 17h.01"/></svg>',
};

const STATUS_BADGES = {
  pending: ['Pendente', ''],
  confirmed: ['Registrada', 'confirmed'],
  cancelled: ['Cancelada', 'cancelled'],
  failed: ['Não registrada', 'failed'],
  undone: ['Desfeita', 'cancelled'],
  stale: ['Não confirmada', 'cancelled'],
  partial: ['Registro parcial', 'failed'],
  done: ['Concluída', 'confirmed'],
  expired: ['Não concluída', 'cancelled'],
};

export function formatCurrency(amount) { return Number(amount).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
export function formatDate(date) { if (!date) return 'Hoje'; const [year, month, day] = date.split('-'); return `${day}/${month}/${year}`; }
export function formatTime(at) { return new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }

export function dayLabel(at, now = Date.now()) {
  const day = (value) => new Date(value).toDateString();
  if (day(at) === day(now)) return 'Hoje';
  if (day(at) === day(now - 86_400_000)) return 'Ontem';
  return new Date(at).toLocaleDateString('pt-BR');
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function detailRow(icon, label, value) {
  const row = element('div', 'detail-row');
  const iconBox = element('span', 'detail-icon');
  iconBox.innerHTML = icons[icon];
  row.append(iconBox, element('span', 'detail-label', label), element('span', 'detail-value', value));
  return row;
}

function cardHeading(iconHtml, typeText, amountText, badge) {
  const heading = element('div', 'transaction-heading');
  const icon = element('div', 'transaction-icon');
  icon.innerHTML = iconHtml;
  const copy = element('div');
  copy.append(element('span', 'transaction-type', typeText), element('strong', 'transaction-amount', amountText));
  heading.append(icon, copy, badge);
  return heading;
}

export function setPreviewStatus(card, status) {
  const badge = card?.querySelector('.pending-badge');
  if (!badge) return;
  const [label, variant] = STATUS_BADGES[status] || STATUS_BADGES.pending;
  badge.textContent = label;
  badge.className = `pending-badge${variant ? ` ${variant}` : ''}`;
}

function previewCard(entry, actions) {
  const data = entry.data;
  const card = element('section', 'transaction-card');
  card.setAttribute('aria-label', 'Prévia da movimentação');
  const badge = element('span', 'pending-badge');
  card.append(cardHeading(icons[data.type] || icons.expense, data.type === 'income' ? 'RECEITA' : 'DESPESA', formatCurrency(data.amount), badge));
  const details = element('div', 'transaction-details');
  // A split purchase shows one row per part: category and its value.
  const categoryRows = data.parts?.length
    ? data.parts.map((part) => detailRow('category', part.category, formatCurrency(part.amount)))
    : [detailRow('category', 'Categoria', data.category)];
  details.append(...categoryRows, detailRow('payee', 'Beneficiário', data.description), detailRow('account', 'Conta', data.account), detailRow('date', 'Data', formatDate(data.date)));
  if (data.notes) details.append(detailRow('payee', 'Nota', data.notes));
  card.append(details);
  const status = entry.status === 'pending' && !actions ? 'stale' : entry.status;
  setPreviewStatus(card, status);

  if (actions) {
    const row = element('div', 'message-actions');
    row.dataset.live = 'preview';
    row.dataset.liveEntry = entry.id;
    const confirmButton = element('button', '', '✓  Aprovar');
    const cancelButton = element('button', 'secondary', '×  Cancelar');
    confirmButton.type = 'button';
    cancelButton.type = 'button';
    confirmButton.addEventListener('click', () => actions.onConfirm({ card, row, confirmButton, cancelButton }));
    cancelButton.addEventListener('click', () => actions.onCancel({ card, row, confirmButton, cancelButton }));
    row.append(confirmButton, cancelButton);
    card.append(row);
  }
  return card;
}

/** A preview row of a batch or draft: payee, signed amount, category (or parts) and date. */
function itemRow(item, index) {
  const row = element('li', 'batch-item');
  const line = element('div', 'batch-line');
  line.append(
    element('span', 'batch-title', `${index + 1}. ${item.description || (item.type === 'income' ? 'Receita' : 'Despesa')}`),
    element('span', `batch-amount ${item.type === 'income' ? 'income' : 'expense'}`, item.amount === null || item.amount === undefined ? 'valor a definir' : `${item.type === 'income' ? '+' : '−'} ${formatCurrency(item.amount)}`),
  );
  const parts = item.parts?.length
    ? item.parts.map((part) => `${part.category || 'categoria a definir'}${part.amount === null || part.amount === undefined ? '' : ` ${formatCurrency(part.amount)}`}`).join(' + ')
    : (item.category || 'categoria a definir');
  const meta = element('div', 'batch-meta', item.date ? `${parts} · ${formatDate(item.date)}` : parts);
  if (!item.category && !item.parts?.every((part) => part.category)) meta.classList.add('missing');
  row.append(line, meta);
  return row;
}

function actionRow(type, entryId, buttons) {
  const row = element('div', 'message-actions');
  row.dataset.live = type;
  row.dataset.liveEntry = entryId;
  row.append(...buttons);
  return row;
}

function button(text, className, onClick) {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function batchCard(entry, actions) {
  const data = entry.data;
  const card = element('section', 'transaction-card batch-card');
  card.setAttribute('aria-label', `Prévia de ${data.items.length} movimentações`);
  const badge = element('span', 'pending-badge');
  card.append(cardHeading(icons.batch, 'VÁRIAS MOVIMENTAÇÕES', `${data.items.length} itens`, badge));
  const list = element('ol', 'batch-list');
  list.append(...data.items.map(itemRow));
  card.append(list);
  const totals = element('div', 'transaction-details');
  if (data.expenses) totals.append(detailRow('expense', 'Total de despesas', formatCurrency(data.expenses)));
  if (data.incomes) totals.append(detailRow('income', 'Total de receitas', formatCurrency(data.incomes)));
  if (data.account) totals.append(detailRow('account', 'Conta', data.account));
  card.append(totals, element('p', 'card-note', 'Depois de registrado, o lote inteiro pode ser desfeito por 10 minutos.'));
  setPreviewStatus(card, entry.status === 'pending' && !actions ? 'stale' : entry.status);
  if (actions) {
    const confirmButton = element('button', '', '✓  Aprovar todas');
    const cancelButton = element('button', 'secondary', '×  Cancelar');
    confirmButton.type = 'button';
    cancelButton.type = 'button';
    const row = actionRow('batch', entry.id, [confirmButton, cancelButton]);
    confirmButton.addEventListener('click', () => actions.onConfirm({ card, row, confirmButton, cancelButton }));
    cancelButton.addEventListener('click', () => actions.onCancel({ card, row, confirmButton, cancelButton }));
    card.append(row);
  }
  return card;
}

/**
 * Missing data of an AI draft. Live only: suggestion buttons and a native
 * select with every visible category for each missing category; amounts are
 * answered in the chat. Restored from history, it is a plain summary.
 */
function clarifyCard(entry, actions) {
  const data = entry.data;
  const card = element('section', 'transaction-card clarify-card');
  card.setAttribute('aria-label', 'Informações que faltam');
  const badge = element('span', 'pending-badge');
  const count = data.missing.length;
  card.append(cardHeading(icons.question, 'FALTAM INFORMAÇÕES', `${count} ${count === 1 ? 'item' : 'itens'}`, badge));
  const list = element('ol', 'batch-list');
  list.append(...data.items.map(itemRow));
  card.append(list);
  setPreviewStatus(card, entry.status === 'pending' && !actions ? 'expired' : entry.status);
  if (!actions) return card;

  const controls = element('div', 'clarify-controls');
  controls.dataset.live = 'clarify';
  controls.dataset.liveEntry = entry.id;
  const disableAll = () => controls.querySelectorAll('button, select').forEach((node) => { node.disabled = true; });
  actions.missing.forEach((missing, index) => {
    const group = element('fieldset', 'clarify-field');
    group.append(element('legend', '', missing.label));
    if (missing.field !== 'category') {
      group.append(element('p', 'card-note', 'Responda com o valor aqui no chat.'));
      controls.append(group);
      return;
    }
    if (missing.suggestions.length) {
      const suggestions = element('div', 'suggestion-actions');
      for (const suggestion of missing.suggestions) {
        suggestions.append(button(`Usar “${suggestion.name}”`, '', () => {
          disableAll();
          actions.onChoose(missing, suggestion);
        }));
      }
      group.append(suggestions);
    }
    const pickId = `${entry.id}-pick-${index}`;
    const picker = element('div', 'clarify-picker');
    const label = element('label', 'sr-only', `Outra categoria para: ${missing.label}`);
    label.htmlFor = pickId;
    const select = element('select');
    select.id = pickId;
    select.append(Object.assign(document.createElement('option'), { value: '', textContent: missing.suggestions.length ? 'Outra categoria…' : 'Escolha a categoria…' }));
    for (const category of actions.categories) select.append(Object.assign(document.createElement('option'), { value: category.id, textContent: category.name }));
    const use = button('Usar', 'secondary-button', () => {
      const chosen = actions.categories.find((category) => category.id === select.value);
      if (!chosen) {
        select.focus();
        return;
      }
      disableAll();
      actions.onChoose(missing, chosen);
    });
    picker.append(label, select, use);
    group.append(picker);
    controls.append(group);
  });
  controls.append(element('div', 'clarify-footer'));
  controls.lastChild.append(button('Descartar estas movimentações', 'link-button', () => {
    disableAll();
    actions.onDiscard();
  }));
  card.append(controls);
  return card;
}

const SEARCH_TITLES = {
  list: 'BUSCA', sum: 'TOTAL', count: 'CONTAGEM', max: 'MAIOR VALOR', min: 'MENOR VALOR', by_month: 'POR MÊS',
};
const TYPE_PLURAL = { expense: 'despesas', income: 'receitas', any: 'transações' };
const TYPE_SINGULAR = { expense: 'despesa', income: 'receita', any: 'transação' };

export function searchPeriod({ from, to }) {
  if (!from) return 'Todo o histórico';
  return from === to ? formatDate(from) : `${formatDate(from)} a ${formatDate(to)}`;
}

function searchCard(data) {
  const card = element('section', 'transaction-card info-card search-card');
  card.setAttribute('aria-label', 'Resultado da busca de transações');
  let headline;
  if (data.result === 'sum' || data.result === 'by_month') headline = formatCurrency((data.type === 'any' ? data.total : Math.abs(data.total)) / 100);
  else if ((data.result === 'max' || data.result === 'min') && data.transactions[0]) headline = formatCurrency(Math.abs(data.transactions[0].amount) / 100);
  else headline = `${data.count} ${(data.count === 1 ? TYPE_SINGULAR : TYPE_PLURAL)[data.type] || 'transações'}`;
  card.append(cardHeading(icons.search, `${SEARCH_TITLES[data.result] || 'BUSCA'} · ${(TYPE_PLURAL[data.type] || 'transações').toUpperCase()}`, headline, element('span')));
  const details = element('div', 'transaction-details');
  details.append(detailRow('account', 'Conta', data.account));
  if (data.payees?.length) details.append(detailRow('payee', 'Beneficiário', data.payees.join(', ')));
  if (data.notes) details.append(detailRow('notes', 'Nas notas', `“${data.notes}”`));
  if (data.category) details.append(detailRow('category', 'Categoria', data.category));
  details.append(detailRow('date', 'Período', searchPeriod(data)));
  if (data.result === 'by_month') details.append(detailRow('batch', 'Transações', String(data.count)));
  if (data.result === 'sum' || data.result === 'count') details.append(detailRow('batch', data.result === 'sum' ? 'Transações' : 'Soma', data.result === 'sum' ? String(data.count) : formatCurrency(Math.abs(data.total) / 100)));
  card.append(details);
  if (data.result === 'by_month' && data.months?.length) {
    const list = element('ol', 'search-list month-list');
    list.setAttribute('aria-label', 'Total por mês');
    for (const item of data.months) {
      const row = element('li', 'search-item');
      const line = element('div', 'batch-line');
      const value = data.type === 'any' ? item.total : Math.abs(item.total);
      line.append(
        element('span', 'batch-title', summaryMonth(item.month)),
        element('span', `batch-amount ${item.count ? (data.type === 'income' || (data.type === 'any' && item.total > 0) ? 'income' : 'expense') : 'empty'}`, formatCurrency(value / 100)),
      );
      row.append(line);
      if (item.count) row.append(element('div', 'batch-meta', `${item.count} ${item.count === 1 ? TYPE_SINGULAR[data.type] || 'transação' : TYPE_PLURAL[data.type] || 'transações'}`));
      list.append(row);
    }
    card.append(list);
  }
  if (data.transactions?.length) {
    const list = element('ol', 'search-list');
    for (const transaction of data.transactions) {
      const item = element('li', 'search-item');
      const line = element('div', 'batch-line');
      line.append(
        element('span', 'batch-title', transaction.payee || 'Sem beneficiário'),
        element('span', `batch-amount ${transaction.amount > 0 ? 'income' : 'expense'}`, `${transaction.amount > 0 ? '+' : '−'} ${formatCurrency(Math.abs(transaction.amount) / 100)}`),
      );
      item.append(line, element('div', 'batch-meta', `${formatDate(transaction.date)}${transaction.category ? ` · ${transaction.category}` : ''}`));
      if (transaction.notes) item.append(element('div', 'batch-meta notes-meta', transaction.notes));
      list.append(item);
    }
    card.append(list);
  }
  return card;
}

const MONTH_NAMES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** "2026-11" → "Novembro de 2026" */
export function summaryMonth(month) {
  const [year, index] = String(month || '').split('-').map(Number);
  const name = MONTH_NAMES[index - 1];
  return name ? `${name.charAt(0).toUpperCase()}${name.slice(1)} de ${year}` : '';
}

const signedCurrency = (cents) => `${cents < 0 ? '−' : '+'} ${formatCurrency(Math.abs(cents) / 100)}`;

function sectionTitle(text) {
  return element('h3', 'card-section-title', text);
}

/** Month summary: the chat's account first, then the budget of the month (all accounts). Amounts in cents. */
function summaryCard(data) {
  const card = element('section', 'transaction-card info-card summary-card');
  card.setAttribute('aria-label', `Resumo de ${summaryMonth(data.month)}`);
  card.append(cardHeading(icons.summary, 'RESUMO DO MÊS', summaryMonth(data.month), element('span')));

  card.append(sectionTitle(`Conta ${data.account}`));
  const account = element('div', 'transaction-details');
  account.append(
    detailRow('date', 'Período', searchPeriod(data)),
    detailRow('expense', 'Despesas', `${formatCurrency(data.expenses / 100)} (${data.expenseCount})`),
    detailRow('income', 'Receitas', `${formatCurrency(data.incomes / 100)} (${data.incomeCount})`),
    detailRow('account', 'Resultado', signedCurrency(data.net)),
  );
  card.append(account);
  if (data.topExpenses?.length) {
    const list = element('ol', 'search-list');
    list.setAttribute('aria-label', 'Maiores despesas');
    for (const expense of data.topExpenses) {
      const item = element('li', 'search-item');
      const line = element('div', 'batch-line');
      line.append(
        element('span', 'batch-title', expense.payee || 'Sem beneficiário'),
        element('span', 'batch-amount expense', `− ${formatCurrency(Math.abs(expense.amount) / 100)}`),
      );
      item.append(line, element('div', 'batch-meta', `${formatDate(expense.date)}${expense.category ? ` · ${expense.category}` : ''}`));
      list.append(item);
    }
    card.append(sectionTitle('Maiores despesas'), list);
  }

  card.append(sectionTitle('Orçamento do mês (todas as contas)'));
  if (!data.budget) {
    card.append(element('p', 'card-note', 'O orçamento não tem dados deste mês.'));
    return card;
  }
  const budget = element('div', 'transaction-details');
  budget.append(detailRow('category', 'Gasto', `${formatCurrency(data.budget.spent / 100)} de ${formatCurrency(data.budget.budgeted / 100)}`));
  if (data.budget.topCategories?.length) {
    const top = detailRow('summary', 'Onde mais gastou', data.budget.topCategories.map((category) => `${category.name} (${formatCurrency(category.spent / 100)})`).join(', '));
    top.classList.add('stacked');
    budget.append(top);
  }
  const overspent = data.budget.overspent?.length
    ? data.budget.overspent.map((category) => `${category.name} (faltam ${formatCurrency(-category.balance / 100)})`).join(', ')
      + (data.budget.overspentCount > data.budget.overspent.length ? ` e mais ${data.budget.overspentCount - data.budget.overspent.length}` : '')
    : 'Nenhuma';
  const overspentRow = detailRow('alert', 'Estouradas', overspent);
  if (data.budget.overspent?.length) overspentRow.classList.add('is-alert', 'stacked');
  budget.append(overspentRow);
  card.append(budget);
  return card;
}

function spendingCard(data) {
  const card = element('section', 'transaction-card info-card');
  card.setAttribute('aria-label', 'Resultado da consulta de disponibilidade');
  const enough = data.canSpend;
  const badge = element('span', `result-badge ${enough ? 'yes' : 'no'}`, enough ? 'Sim' : 'Não');
  card.append(cardHeading(icons.category, enough ? 'DISPONÍVEL' : 'SALDO INSUFICIENTE', formatCurrency(data.remaining / 100), badge));
  const details = element('div', 'transaction-details');
  details.append(
    detailRow('category', 'Categoria', data.category),
    detailRow('account', 'Disponível atualmente', formatCurrency(data.available / 100)),
    detailRow('payee', 'Você quer gastar', formatCurrency(data.requested / 100)),
    detailRow('date', 'Restará', formatCurrency(data.remaining / 100)),
  );
  card.append(details);
  return card;
}

/** What a screen reader hears for a new assistant message: its text plus the card's headline. */
export function announcementFor(entry) {
  if (!entry || entry.role !== 'assistant') return '';
  const text = String(entry.text || '');
  if (entry.kind === 'preview' && entry.data) {
    return `${text} ${entry.data.type === 'income' ? 'Receita' : 'Despesa'} de ${formatCurrency(entry.data.amount)}.`;
  }
  if (entry.kind === 'batch' && entry.data) return `${text} ${entry.data.items.length} movimentações aguardando aprovação.`;
  if (entry.kind === 'summary' && entry.data) {
    const { data } = entry;
    return `${text} Despesas de ${formatCurrency(data.expenses / 100)} e receitas de ${formatCurrency(data.incomes / 100)} na conta ${data.account}.`;
  }
  return text;
}

/**
 * `announcer` is a small polite live region outside the conversation. The
 * conversation itself is not a live region: it is rebuilt whenever a chat is
 * opened, and a live region there made screen readers (TalkBack) read the
 * whole history again on every open. Only new assistant messages are spoken.
 */
export function createChatView({ conversation, typingIndicator, announcer }) {
  let lastDay = null;

  function announce(entry) {
    const text = announcementFor(entry);
    // A new node each time, so a repeated text ("Movimentação cancelada.") is spoken again.
    if (text && announcer) announcer.replaceChildren(element('span', '', text));
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      conversation.scrollTo({ top: conversation.scrollHeight, behavior: 'smooth' });
      requestAnimationFrame(() => { conversation.scrollTop = conversation.scrollHeight; });
    });
  }

  function datePill(at) {
    const label = dayLabel(at);
    if (label === lastDay) return;
    lastDay = label;
    conversation.append(element('div', 'date-pill', label));
  }

  /** Appends one entry. `actions` makes a pending preview actionable (only live, never restored). */
  function append(entry, { restored = false, actions } = {}) {
    datePill(entry.at);
    const isUser = entry.role === 'user';
    const previous = conversation.lastElementChild;
    const grouped = !isUser && previous?.classList.contains('assistant-row');
    const row = element('div', `message-row ${isUser ? 'user-row' : 'assistant-row'}${grouped ? ' grouped-row' : ''}${restored ? ' restored' : ''}`);
    if (!isUser && !grouped) {
      const avatar = element('div', 'avatar');
      avatar.setAttribute('aria-hidden', 'true');
      avatar.innerHTML = '<img src="/brand/finance-chat-symbol.svg" alt="" width="32" height="32">';
      row.append(avatar);
    }
    const content = element('div');
    if (!isUser && !grouped) content.append(element('span', 'sender-label', 'Finance Chat'));
    const kindClass = { error: ' error-message', warning: ' warning-message' }[entry.kind] || '';
    const bubble = element('div', `message ${isUser ? 'user-message' : 'assistant-message'}${kindClass}`, entry.text);
    content.append(bubble);

    let card = null;
    if (entry.kind === 'preview' && entry.data) card = previewCard(entry, actions);
    if (entry.kind === 'spending' && entry.data) card = spendingCard(entry.data);
    if (entry.kind === 'batch' && entry.data) card = batchCard(entry, actions);
    if (entry.kind === 'clarify' && entry.data) card = clarifyCard(entry, actions);
    if (entry.kind === 'search' && entry.data) card = searchCard(entry.data);
    if (entry.kind === 'summary' && entry.data) card = summaryCard(entry.data);
    if (card) bubble.append(card);
    if (actions?.suggestions?.length) {
      const row = element('div', 'suggestion-actions');
      row.dataset.live = 'suggestions';
      row.dataset.liveEntry = entry.id;
      for (const suggestion of actions.suggestions) {
        const button = element('button', '', `Usar “${suggestion.name}”`);
        button.type = 'button';
        button.addEventListener('click', () => {
          row.querySelectorAll('button').forEach((item) => { item.disabled = true; });
          actions.onPick(suggestion);
        });
        row.append(button);
      }
      bubble.append(row);
    }
    if (actions?.onUndo) {
      const row = element('div', 'undo-actions');
      row.dataset.live = 'undo';
      row.dataset.liveEntry = entry.id;
      const button = element('button', '', '↶  Desfazer');
      button.type = 'button';
      button.setAttribute('aria-label', actions.undoLabel || 'Desfazer esta movimentação');
      button.addEventListener('click', () => {
        button.disabled = true;
        actions.onUndo();
      });
      row.append(button);
      bubble.append(row);
    }
    if (!card) {
      const time = element('time', 'message-time', formatTime(entry.at));
      time.dateTime = new Date(entry.at).toISOString();
      content.append(time);
    }
    // Transparency: answers that needed the AI say so (and that it used tokens).
    if (entry.ai) content.append(element('span', 'ai-note', '✦ Interpretado pela IA'));

    row.append(content);
    conversation.append(row);
    if (!restored) {
      scrollToBottom();
      announce(entry);
    }
    return { row, bubble, card };
  }

  return {
    append,
    scrollToBottom,

    render(entries, { greeting, liveActions } = {}) {
      conversation.replaceChildren();
      lastDay = null;
      if (!entries.length && greeting) append({ role: 'assistant', kind: 'text', text: greeting, at: Date.now() }, { restored: true });
      for (const entry of entries) append(entry, { restored: true, actions: liveActions?.(entry) });
      conversation.scrollTop = conversation.scrollHeight;
    },

    setTyping(visible) {
      typingIndicator.hidden = !visible;
      if (visible) scrollToBottom();
    },
  };
}
