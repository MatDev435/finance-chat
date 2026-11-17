import { api, onSessionExpired } from './js/api.js';
import { createChatView, formatTime, setPreviewStatus } from './js/chat-view.js';
import { browserStorage, createHistory } from './js/history.js';
import { entrySummary, initials, reconcileSelection, resolveInitialAccount, viewFor } from './js/navigation.js';
import { createSettings } from './js/settings.js';
import { createSetup } from './js/setup.js';

const $ = (selector) => document.querySelector(selector);
const app = $('#app');
const workspace = $('[data-screen-name="workspace"]');
const messageInput = $('#message');
const previewButton = $('#preview-button');
const mobileQuery = window.matchMedia('(max-width: 700px)');
const storage = browserStorage();
const GREETING = 'Olá! O que você deseja registrar hoje?';
const PREVIEW_TEXT = 'Entendi! Encontrei uma movimentação. Confira os detalhes antes de confirmar.';

const state = {
  me: null,
  accounts: [],
  selectedId: null,
  settingsOpen: false,
  history: null,
  busy: new Set(),
  /** history entry id → { accountId, pendingId }. Memory only: never persisted. */
  live: new Map(),
};

const chatView = createChatView({ conversation: $('#conversation'), typingIndicator: $('#typing-indicator') });
let entryCounter = 0;
const newEntryId = () => `m${Date.now().toString(36)}${(entryCounter += 1).toString(36)}`;

/* ---------- Screens ---------- */

function showScreen(name) {
  app.dataset.screen = name;
  document.querySelectorAll('[data-screen-name]').forEach((screen) => { screen.hidden = screen.dataset.screenName !== name; });
  $('#menu-anchor').hidden = name !== 'workspace';
  closeMenu();
  if (name !== 'workspace') delete app.dataset.view;
}

function resetSession() {
  state.me = null;
  state.accounts = [];
  state.selectedId = null;
  state.settingsOpen = false;
  state.history = null;
  state.busy.clear();
  state.live.clear();
  $('#conversation').replaceChildren();
  $('#account-list').replaceChildren();
}

/* ---------- Auth ---------- */

const authForm = $('#auth-form');
let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  for (const tab of document.querySelectorAll('.segmented [data-mode]')) tab.setAttribute('aria-selected', String(tab.dataset.mode === mode));
  $('#auth-submit').textContent = mode === 'register' ? 'Criar conta' : 'Entrar';
  authForm.elements.password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('#auth-hint').hidden = mode !== 'register';
  $('#auth-error').hidden = true;
}

async function showAuth(message = '') {
  showScreen('auth');
  let options = { signupOpen: true, firstUser: false };
  try { options = await api('GET', '/api/auth/options'); } catch { /* keep defaults */ }
  $('#tab-register').hidden = !options.signupOpen;
  $('#signup-closed').hidden = options.signupOpen;
  setAuthMode(options.firstUser ? 'register' : 'login');
  if (message) {
    $('#auth-error').textContent = message;
    $('#auth-error').hidden = false;
  }
  authForm.elements.username.focus({ preventScroll: true });
}

document.querySelectorAll('.segmented [data-mode]').forEach((tab) => tab.addEventListener('click', () => setAuthMode(tab.dataset.mode)));

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = $('#auth-submit');
  const error = $('#auth-error');
  submit.disabled = true;
  error.hidden = true;
  try {
    await api('POST', authMode === 'register' ? '/api/auth/register' : '/api/auth/login', {
      username: authForm.elements.username.value,
      password: authForm.elements.password.value,
    });
    authForm.reset();
    await boot();
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

async function logout() {
  try { await api('POST', '/api/auth/logout'); } catch { /* the cookies are cleared anyway when possible */ }
  state.history?.clear();
  resetSession();
  if (window.history.state?.financeChat) window.history.replaceState(null, '');
  await showAuth();
}

onSessionExpired(() => {
  if (!state.me) return;
  resetSession();
  showAuth('Sua sessão expirou. Entre novamente.');
});

/* ---------- Setup and settings ---------- */

const setup = createSetup({
  form: $('#setup-form'),
  onSaved: () => boot(),
  onCancel: () => enterWorkspace(state.me),
  onLogout: () => logout(),
});

function openSetup({ editing = false, message = '' } = {}) {
  showScreen('setup');
  setup.open({ connection: state.me?.connection, editing, message });
}

const settings = createSettings({
  panel: $('#settings-panel'),
  onDefaultSaved: (saved) => {
    state.me.settings = saved;
    renderAccountList();
  },
  onEditConnection: () => openSetup({ editing: true }),
  onLogout: () => logout(),
  onClose: () => goBack(),
});

function openSettings() {
  if (!state.me) return;
  state.settingsOpen = true;
  settings.open({ me: state.me, accounts: state.accounts });
  pushMobileState('settings');
  renderView();
}

/* ---------- Menu ---------- */

const menuButton = $('#menu-button');
const menu = $('#options-menu');

function closeMenu() {
  menu.hidden = true;
  menuButton.setAttribute('aria-expanded', 'false');
}

menuButton.addEventListener('click', (event) => {
  event.stopPropagation();
  const open = menu.hidden;
  menu.hidden = !open;
  menuButton.setAttribute('aria-expanded', String(open));
  if (open) menu.querySelector('button')?.focus();
});

menu.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  closeMenu();
  if (action === 'sync') loadAccounts();
  if (action === 'settings') openSettings();
  if (action === 'logout') logout();
});

document.addEventListener('click', (event) => { if (!menu.hidden && !event.target.closest('#menu-anchor')) closeMenu(); });
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || menu.hidden) return;
  closeMenu();
  menuButton.focus();
});

/* ---------- Workspace: accounts ---------- */

function currentAccount() {
  return state.accounts.find((account) => account.id === state.selectedId) || null;
}

function setAccountsStatus(text, error = false) {
  const status = $('#accounts-status');
  status.textContent = text;
  status.classList.toggle('error', error);
}

function renderAccountList() {
  const list = $('#account-list');
  list.replaceChildren();
  if (!state.accounts.length) {
    const empty = document.createElement('p');
    empty.className = 'list-empty';
    empty.textContent = 'Nenhuma conta aberta encontrada no Actual Budget. Crie uma conta no Actual e depois atualize a lista.';
    list.append(empty);
    return;
  }
  for (const account of state.accounts) {
    const last = state.history?.last(account.id);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'account-item';
    item.dataset.accountId = account.id;
    item.setAttribute('aria-current', String(account.id === state.selectedId));

    const avatar = document.createElement('span');
    avatar.className = 'avatar account-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = initials(account.name);

    const copy = document.createElement('span');
    copy.className = 'account-copy';
    const name = document.createElement('strong');
    name.textContent = account.name;
    const preview = document.createElement('span');
    preview.className = 'account-preview';
    preview.textContent = entrySummary(last) || 'Nenhuma mensagem ainda';
    copy.append(name, preview);

    const meta = document.createElement('span');
    meta.className = 'account-meta';
    if (last) meta.append(Object.assign(document.createElement('time'), { textContent: formatTime(last.at) }));
    if (account.id === state.me?.settings.defaultAccountId) {
      meta.append(Object.assign(document.createElement('span'), { className: 'default-badge', textContent: 'Padrão' }));
    }

    item.append(avatar, copy, meta);
    item.addEventListener('click', () => selectAccount(account.id));
    list.append(item);
  }
}

async function loadAccounts({ initial = false } = {}) {
  const syncButton = $('#sync-accounts');
  syncButton.classList.add('is-spinning');
  syncButton.disabled = true;
  setAccountsStatus('Atualizando contas do Actual...');
  const previous = currentAccount();
  try {
    const { accounts } = await api('GET', '/api/accounts');
    state.accounts = accounts;
    setAccountsStatus(`Contas atualizadas às ${formatTime(Date.now())}.`);
    if (initial) {
      const { accountId, defaultMissing } = resolveInitialAccount({ accounts, defaultAccountId: state.me.settings.defaultAccountId });
      if (defaultMissing) setAccountsStatus('A conta padrão não está mais disponível no Actual. Escolha uma conta ou altere a preferência nas configurações.', true);
      if (accountId) state.selectedId = accountId;
    } else if (previous && !reconcileSelection(accounts, previous.id)) {
      state.selectedId = null;
      $('#empty-chat-text').textContent = `A conta "${previous.name}" não está mais disponível no Actual Budget. Escolha outra conta.`;
    }
  } catch (error) {
    if (error.code === 'CONNECTION_REQUIRED' || error.code === 'CONNECTION_UNREADABLE') {
      openSetup({ message: error.message });
      return;
    }
    setAccountsStatus(error.message, true);
  } finally {
    syncButton.classList.remove('is-spinning');
    syncButton.disabled = false;
  }
  renderAccountList();
  renderView();
}

async function enterWorkspace(me) {
  resetSession();
  state.me = me;
  state.history = createHistory(storage, me.user.id);
  showScreen('workspace');
  $('#empty-chat-text').textContent = 'Cada conta do Actual Budget tem a sua conversa. As movimentações enviadas em uma conversa são registradas somente naquela conta.';
  renderView();
  await loadAccounts({ initial: true });
}

/* ---------- Workspace: views and navigation ---------- */

function pushMobileState(view) {
  if (mobileQuery.matches) window.history.pushState({ financeChat: view }, '');
}

function renderView() {
  const view = viewFor({ mobile: mobileQuery.matches, selectedId: state.selectedId, settingsOpen: state.settingsOpen });
  workspace.dataset.view = view;
  app.dataset.view = view;
  $('#settings-panel').hidden = view !== 'settings';
  $('#chat').hidden = view !== 'chat';
  $('#empty-chat').hidden = view !== 'empty';
  if (view === 'chat') renderChat();
}

function renderChat() {
  const account = currentAccount();
  if (!account) return;
  $('#chat-title').textContent = account.name;
  $('#chat-avatar').textContent = initials(account.name);
  chatView.render(state.history.load(account.id), {
    greeting: GREETING,
    liveActions: (entry) => (entry.kind === 'preview' && entry.status === 'pending' && state.live.has(entry.id) ? previewActions(account.id, entry.id) : undefined),
  });
  syncBusyIndicators();
}

function selectAccount(accountId) {
  if (state.selectedId === accountId && !state.settingsOpen) return;
  const wasInList = !state.selectedId && !state.settingsOpen;
  state.selectedId = accountId;
  state.settingsOpen = false;
  if (wasInList) pushMobileState('chat');
  renderAccountList();
  renderView();
  if (!mobileQuery.matches) messageInput.focus({ preventScroll: true });
}

/** Back on mobile (and closing settings on desktop). */
function goBack() {
  if (mobileQuery.matches && window.history.state?.financeChat) {
    window.history.back();
    return;
  }
  stepBack();
}

function stepBack() {
  if (state.settingsOpen) state.settingsOpen = false;
  else if (mobileQuery.matches) state.selectedId = null;
  renderAccountList();
  renderView();
}

window.addEventListener('popstate', () => { if (app.dataset.screen === 'workspace') stepBack(); });
$('#back-to-list').addEventListener('click', () => goBack());
$('#sync-accounts').addEventListener('click', () => loadAccounts());
mobileQuery.addEventListener('change', () => { if (app.dataset.screen === 'workspace') renderView(); });

/* ---------- Chat ---------- */

function syncBusyIndicators() {
  const busy = state.busy.has(state.selectedId);
  chatView.setTyping(busy);
  previewButton.disabled = busy;
}

function setBusy(accountId, busy) {
  if (busy) state.busy.add(accountId);
  else state.busy.delete(accountId);
  if (accountId === state.selectedId) syncBusyIndicators();
}

function isVisible(accountId) {
  return app.dataset.screen === 'workspace' && state.selectedId === accountId && !state.settingsOpen;
}

/** Stores the entry in this chat's local history and shows it if the chat is open. */
function addEntry(accountId, entry, { live = false } = {}) {
  const full = { id: newEntryId(), at: Date.now(), ...entry };
  state.history?.append(accountId, full);
  if (isVisible(accountId)) chatView.append(full, { actions: live ? previewActions(accountId, full.id) : undefined });
  renderAccountList();
  return full;
}

/** The server keeps one pending preview per chat: older cards stop being actionable. */
function retireLivePreviews(accountId) {
  for (const [entryId, item] of state.live) if (item.accountId === accountId) state.live.delete(entryId);
  if (isVisible(accountId)) $('#conversation').querySelectorAll('.message-actions').forEach((row) => row.remove());
}

function updateAccountName(account) {
  const known = state.accounts.find((item) => item.id === account.id);
  if (!known || known.name === account.name) return;
  known.name = account.name;
  renderAccountList();
  if (state.selectedId === account.id) {
    $('#chat-title').textContent = account.name;
    $('#chat-avatar').textContent = initials(account.name);
  }
}

function handleChatError(accountId, error, text = error.message) {
  addEntry(accountId, { role: 'assistant', kind: 'error', text });
  if (error.code === 'ACCOUNT_UNAVAILABLE') loadAccounts();
  if (error.code === 'CONNECTION_REQUIRED' || error.code === 'CONNECTION_UNREADABLE') openSetup({ message: error.message });
}

$('#command-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const accountId = state.selectedId;
  const text = messageInput.value.trim();
  if (!accountId || !text || state.busy.has(accountId)) return;
  retireLivePreviews(accountId);
  addEntry(accountId, { role: 'user', kind: 'text', text });
  messageInput.value = '';
  setBusy(accountId, true);
  try {
    const data = await api('POST', '/api/chat/preview', { accountId, message: text });
    if (data.kind === 'category-available') {
      addEntry(accountId, { role: 'assistant', kind: 'text', text: data.message });
    } else if (data.kind === 'category-can-spend') {
      addEntry(accountId, {
        role: 'assistant', kind: 'spending', text: data.message,
        data: { category: data.category.name, available: data.available, requested: data.requested, remaining: data.remaining, canSpend: data.canSpend },
      });
    } else {
      const { preview } = data;
      const entryId = newEntryId();
      state.live.set(entryId, { accountId, pendingId: data.pendingId });
      addEntry(accountId, {
        id: entryId, role: 'assistant', kind: 'preview', text: PREVIEW_TEXT, status: 'pending',
        data: {
          type: preview.command.type, amount: preview.command.amount, description: preview.command.description,
          category: preview.category.name, account: preview.account.name, date: preview.transaction.date, notes: preview.command.notes,
        },
      }, { live: true });
      updateAccountName(preview.account);
    }
  } catch (error) {
    handleChatError(accountId, error);
  } finally {
    setBusy(accountId, false);
    if (isVisible(accountId) && !mobileQuery.matches) messageInput.focus({ preventScroll: true });
  }
});

function previewActions(accountId, entryId) {
  return {
    onConfirm: (ui) => confirmPreview(accountId, entryId, ui),
    onCancel: (ui) => cancelPreview(accountId, entryId, ui),
  };
}

/** Marks the preview card with its final status, in history and on screen. */
function settlePreview(accountId, entryId, ui, status) {
  state.history?.update(accountId, entryId, { status });
  if (ui.card.isConnected) {
    setPreviewStatus(ui.card, status);
    ui.row.remove();
  } else if (isVisible(accountId)) {
    renderChat();
  }
}

async function confirmPreview(accountId, entryId, ui) {
  const item = state.live.get(entryId);
  if (!item) return;
  state.live.delete(entryId);
  ui.confirmButton.disabled = true;
  ui.cancelButton.disabled = true;
  ui.confirmButton.classList.add('is-loading');
  ui.confirmButton.innerHTML = '<span class="button-spinner" aria-hidden="true"></span><span>Processando...</span>';
  setBusy(accountId, true);
  try {
    const data = await api('POST', '/api/chat/confirm', { pendingId: item.pendingId });
    settlePreview(accountId, entryId, ui, 'confirmed');
    addEntry(accountId, { role: 'assistant', kind: data.synced ? 'text' : 'warning', text: data.message });
    updateAccountName(data.account);
  } catch (error) {
    settlePreview(accountId, entryId, ui, 'failed');
    const text = error.code === 'NETWORK'
      ? 'Não foi possível confirmar se a movimentação foi registrada. Verifique no Actual Budget antes de enviar novamente.'
      : error.message;
    handleChatError(accountId, error, text);
  } finally {
    setBusy(accountId, false);
    if (isVisible(accountId) && !mobileQuery.matches) messageInput.focus({ preventScroll: true });
  }
}

async function cancelPreview(accountId, entryId, ui) {
  const item = state.live.get(entryId);
  if (!item) return;
  state.live.delete(entryId);
  ui.confirmButton.disabled = true;
  ui.cancelButton.disabled = true;
  setBusy(accountId, true);
  try {
    await api('POST', '/api/chat/cancel', { pendingId: item.pendingId });
  } catch {
    // Without its id the preview can no longer be confirmed from this page; it expires on the server.
  } finally {
    settlePreview(accountId, entryId, ui, 'cancelled');
    addEntry(accountId, { role: 'assistant', kind: 'text', text: 'Movimentação cancelada.' });
    setBusy(accountId, false);
  }
}

/* ---------- Boot ---------- */

async function boot() {
  showScreen('loading');
  try {
    const me = await api('GET', '/api/me');
    state.me = me;
    if (!me.connection.configured) {
      openSetup();
      return;
    }
    await enterWorkspace(me);
  } catch (error) {
    if (error.status === 401) {
      resetSession();
      await showAuth();
      return;
    }
    const screen = $('[data-screen-name="loading"]');
    screen.querySelector('p').textContent = error.message;
    if (!screen.querySelector('button')) {
      const retry = Object.assign(document.createElement('button'), { type: 'button', className: 'secondary-button', textContent: 'Tentar novamente' });
      retry.addEventListener('click', () => boot());
      screen.append(retry);
    }
  }
}

boot();
