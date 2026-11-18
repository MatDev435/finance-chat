/** DOM rendering for one conversation. Text always goes through textContent. */

export const icons = {
  expense: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h2l2 11h10l2-8H7"/><circle cx="10" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/></svg>',
  income: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14v12H5z"/><path d="M8 7V5h8v2M12 11v5M9.5 13.5 12 16l2.5-2.5"/></svg>',
  category: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h6l2 3h8v11H4z"/><path d="M7 13h6M7 16h4"/></svg>',
  payee: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v13H4zM7 7V4h10v3M8 11h8M8 15h5"/></svg>',
  account: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/></svg>',
  date: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/></svg>',
};

const STATUS_BADGES = {
  pending: ['Pendente', ''],
  confirmed: ['Registrada', 'confirmed'],
  cancelled: ['Cancelada', 'cancelled'],
  failed: ['Não registrada', 'failed'],
  stale: ['Não confirmada', 'cancelled'],
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
  details.append(detailRow('category', 'Categoria', data.category), detailRow('payee', 'Beneficiário', data.description), detailRow('account', 'Conta', data.account), detailRow('date', 'Data', formatDate(data.date)));
  if (data.notes) details.append(detailRow('payee', 'Nota', data.notes));
  card.append(details);
  const status = entry.status === 'pending' && !actions ? 'stale' : entry.status;
  setPreviewStatus(card, status);

  if (actions) {
    const row = element('div', 'message-actions');
    row.dataset.live = 'preview';
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

export function createChatView({ conversation, typingIndicator }) {
  let lastDay = null;

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
      avatar.innerHTML = icons.account;
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
    if (card) bubble.append(card);
    if (actions?.suggestions?.length) {
      const row = element('div', 'suggestion-actions');
      row.dataset.live = 'suggestions';
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
    if (!card) {
      const time = element('time', 'message-time', formatTime(entry.at));
      time.dateTime = new Date(entry.at).toISOString();
      content.append(time);
    }

    row.append(content);
    conversation.append(row);
    if (!restored) scrollToBottom();
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
