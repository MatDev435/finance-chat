const form = document.querySelector('#command-form');
const messageInput = document.querySelector('#message');
const conversation = document.querySelector('#conversation');
const previewButton = document.querySelector('#preview-button');
const typingIndicator = document.querySelector('#typing-indicator');
let activeActions = null;
const mobileViewport = window.matchMedia('(max-width: 700px)');

function focusAfterInteraction() {
  if (!mobileViewport.matches) messageInput.focus({ preventScroll: true });
}

function scrollConversationToBottom() {
  requestAnimationFrame(() => {
    conversation.scrollTo({ top: conversation.scrollHeight, behavior: 'smooth' });
    requestAnimationFrame(() => {
      conversation.scrollTop = conversation.scrollHeight;
    });
  });
}

function setTyping(visible) {
  typingIndicator.hidden = !visible;
  if (visible) scrollConversationToBottom();
}

const icons = {
  expense: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h2l2 11h10l2-8H7"/><circle cx="10" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/></svg>',
  income: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14v12H5z"/><path d="M8 7V5h8v2M12 11v5M9.5 13.5 12 16l2.5-2.5"/></svg>',
  category: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h6l2 3h8v11H4z"/><path d="M7 13h6M7 16h4"/></svg>',
  payee: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v13H4zM7 7V4h10v3M8 11h8M8 15h5"/></svg>',
  account: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/></svg>',
  date: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/></svg>',
};

function showMessage(text, type = 'assistant', { timestamp = true } = {}) {
  const previous = conversation.lastElementChild;
  const grouped = type !== 'user' && previous?.classList.contains('assistant-row');
  const row = document.createElement('div');
  row.className = `message-row ${type === 'user' ? 'user-row' : 'assistant-row'}${grouped ? ' grouped-row' : ''}`;
  if (type !== 'user' && !grouped) {
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.innerHTML = icons.account;
    row.append(avatar);
  }
  const content = document.createElement('div');
  if (type !== 'user' && !grouped) {
    const sender = document.createElement('span');
    sender.className = 'sender-label';
    sender.textContent = 'Finance Chat';
    content.append(sender);
  }
  const bubble = document.createElement('div');
  bubble.className = `message ${type === 'user' ? 'user-message' : 'assistant-message'}${type === 'error' ? ' error-message' : ''}`;
  bubble.textContent = text;
  content.append(bubble);
  if (timestamp) {
    const time = document.createElement('time');
    time.className = 'message-time';
    time.textContent = 'Agora';
    content.append(time);
  }
  row.append(content);
  conversation.append(row);
  scrollConversationToBottom();
  return { row, bubble };
}

function removeActiveActions() { activeActions?.remove(); activeActions = null; }
function formatCurrency(amount) { return Number(amount).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function formatDate(date) { if (!date) return 'Hoje'; const [year, month, day] = date.split('-'); return `${day}/${month}/${year}`; }

function detailRow(icon, label, value) {
  const row = document.createElement('div');
  row.className = 'detail-row';
  row.innerHTML = `<span class="detail-icon">${icons[icon]}</span><span class="detail-label">${label}</span><span class="detail-value"></span>`;
  row.querySelector('.detail-value').textContent = value;
  return row;
}

function addConfirmationCard(previewMessage, preview) {
  const card = document.createElement('section');
  card.className = 'transaction-card';
  card.setAttribute('aria-label', 'Prévia da movimentação pendente');
  const heading = document.createElement('div');
  heading.className = 'transaction-heading';
  heading.innerHTML = `<div class="transaction-icon">${icons[preview.command.type]}</div><div><span class="transaction-type"></span><strong class="transaction-amount"></strong></div><span class="pending-badge">Pendente</span>`;
  heading.querySelector('.transaction-type').textContent = preview.command.type === 'expense' ? 'DESPESA' : 'RECEITA';
  heading.querySelector('.transaction-amount').textContent = formatCurrency(preview.command.amount);
  const details = document.createElement('div');
  details.className = 'transaction-details';
  details.append(detailRow('category', 'Categoria', preview.category.name), detailRow('payee', 'Beneficiário', preview.command.description), detailRow('account', 'Conta', preview.account.name), detailRow('date', 'Data', formatDate(preview.transaction.date)));
  if (preview.command.notes) details.append(detailRow('payee', 'Nota', preview.command.notes));
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const confirmButton = document.createElement('button');
  confirmButton.type = 'button'; confirmButton.textContent = '✓  Aprovar';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button'; cancelButton.className = 'secondary'; cancelButton.textContent = '×  Cancelar';
  confirmButton.addEventListener('click', () => confirmPending(confirmButton, cancelButton));
  cancelButton.addEventListener('click', () => cancelPending(confirmButton, cancelButton));
  actions.append(confirmButton, cancelButton);
  card.append(heading, details, actions);
  previewMessage.bubble.textContent = 'Entendi! Encontrei uma movimentação. Confira os detalhes antes de confirmar.';
  previewMessage.bubble.append(card);
  activeActions = actions;
  confirmButton.focus();
  scrollConversationToBottom();
}

function addSpendingCheckCard(messageElement, data) {
  const card = document.createElement('section');
  card.className = 'transaction-card info-card';
  card.setAttribute('aria-label', 'Resultado da consulta de disponibilidade');
  const enough = data.canSpend;
  const heading = document.createElement('div');
  heading.className = 'transaction-heading';
  heading.innerHTML = `<div class="transaction-icon">${icons.category}</div><div><span class="transaction-type">${enough ? 'DISPONÍVEL' : 'SALDO INSUFICIENTE'}</span><strong class="transaction-amount"></strong></div><span class="result-badge ${enough ? 'yes' : 'no'}">${enough ? 'Sim' : 'Não'}</span>`;
  heading.querySelector('.transaction-amount').textContent = formatCurrency(data.remaining / 100);
  const details = document.createElement('div');
  details.className = 'transaction-details';
  details.append(
    detailRow('category', 'Categoria', data.category.name),
    detailRow('account', 'Disponível atualmente', formatCurrency(data.available / 100)),
    detailRow('payee', 'Você quer gastar', formatCurrency(data.requested / 100)),
    detailRow('date', 'Restará', formatCurrency(data.remaining / 100)),
  );
  card.append(heading, details);
  messageElement.bubble.append(card);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  previewButton.disabled = true;
  removeActiveActions();
  showMessage(text, 'user');
  messageInput.value = '';
  setTyping(true);
  try {
    const response = await fetch('/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Não foi possível preparar a movimentação.');
    if (data.kind === 'category-available') {
      showMessage(data.message);
    } else if (data.kind === 'category-can-spend') {
      addSpendingCheckCard(showMessage(data.message, 'assistant', { timestamp: false }), data);
    } else {
      addConfirmationCard(showMessage('', 'assistant', { timestamp: false }), data.preview);
    }
  } catch (error) { showMessage(error.message, 'error'); }
  finally { setTyping(false); previewButton.disabled = false; focusAfterInteraction(); }
});

async function confirmPending(confirmButton, cancelButton) {
  confirmButton.disabled = true; cancelButton.disabled = true;
  confirmButton.classList.add('is-loading');
  confirmButton.innerHTML = '<span class="button-spinner" aria-hidden="true"></span><span>Processando...</span>';
  setTyping(true);
  try {
    const response = await fetch('/confirm', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Não foi possível registrar a movimentação.');
    showMessage(data.message); removeActiveActions(); messageInput.value = '';
  } catch (error) { showMessage(error.message, 'error'); removeActiveActions(); }
  finally {
    setTyping(false);
    confirmButton.disabled = false;
    cancelButton.disabled = false;
    confirmButton.classList.remove('is-loading');
    confirmButton.textContent = '✓  Aprovar';
    focusAfterInteraction();
  }
}

async function cancelPending(confirmButton, cancelButton) {
  confirmButton.disabled = true; cancelButton.disabled = true;
  setTyping(true);
  try {
    await fetch('/cancel', { method: 'POST' });
    removeActiveActions(); showMessage('Movimentação cancelada.');
  } finally {
    setTyping(false);
    focusAfterInteraction();
  }
}

requestAnimationFrame(() => messageInput.focus({ preventScroll: true }));
