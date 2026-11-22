import { api, onSessionExpired } from './js/api.js';
import { createChatView, formatTime, setPreviewStatus } from './js/chat-view.js';
import { browserStorage, createHistory, historyPrefix } from './js/history.js';
import { listen } from './js/desktop-bridge.js';
import { entrySummary, initials, reconcileSelection, resolveInitialAccount, sidebarMotion, viewFor } from './js/navigation.js';
import { createSettings } from './js/settings.js';
import { createSetup } from './js/setup.js';
import { createVoiceInput } from './js/voice.js';
import { PREVIEW_TEXT, batchData, batchText, previewData, searchBubbleText, summaryBubbleText } from './js/entry-data.js';

const $ = (selector) => document.querySelector(selector);
const app = $('#app');
const workspace = $('[data-screen-name="workspace"]');
const messageInput = $('#message');
const previewButton = $('#preview-button');
const mobileQuery = window.matchMedia('(max-width: 700px)');
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
/** Auto-focus only on large screens; on phones the user taps the field (accessibility decision). */
function focusComposer() {
  if (!mobileQuery.matches && !$('#chat').hidden) messageInput.focus({ preventScroll: true });
}
const storage = browserStorage();
const GREETING = 'Olá! O que você deseja registrar hoje?';

const state = {
  me: null,
  accounts: [],
  selectedId: null,
  settingsOpen: false,
  history: null,
  busy: new Set(),
  /**
   * history entry id → live action for that message: { type: 'preview' | 'batch', accountId, pendingId },
   * { type: 'suggestions', accountId, message, suggestions },
   * { type: 'clarify', accountId, draftId, missing, categories } or
   * { type: 'undo', accountId, undoId, previewEntryId }. Memory only: never persisted.
   */
  live: new Map(),
};

const chatView = createChatView({ conversation: $('#conversation'), typingIndicator: $('#typing-indicator'), announcer: $('#chat-announcer') });
let entryCounter = 0;
const newEntryId = () => `m${Date.now().toString(36)}${(entryCounter += 1).toString(36)}`;

/* ---------- Screens ---------- */

function showScreen(name) {
  app.dataset.screen = name;
  document.querySelectorAll('[data-screen-name]').forEach((screen) => { screen.hidden = screen.dataset.screenName !== name; });
  closeMenu({ instant: true });
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
  onAiChange: (ai) => {
    state.me.ai = ai;
    updateComposerHint();
  },
  onEditConnection: () => openSetup({ editing: true }),
  onLogout: () => logout(),
  onClose: () => goBack(),
});

/** The composer invites free text when the AI mode is usable (enabled and with a key). */
function updateComposerHint() {
  const aiActive = Boolean(state.me?.ai?.enabled && state.me.ai.hasKey);
  messageInput.placeholder = aiActive ? 'Escreva como preferir: lançamentos, saldos ou buscas...' : 'Digite uma movimentação...';
  $('#privacy-text').textContent = aiActive
    ? 'IA ativa: o que o Finance Chat não entender sozinho vai para o modelo escolhido.'
    : 'Você pode escrever em linguagem natural, como se estivesse falando.';
}

function openSettings() {
  if (!state.me) return;
  state.settingsOpen = true;
  settings.open({ me: state.me, accounts: state.accounts });
  pushMobileState('settings');
  renderView({ navigated: true });
}

/* ---------- User menu (sidebar footer) ---------- */

const menuButton = $('#user-button');
const menu = $('#options-menu');
const menuItems = () => [...menu.querySelectorAll('[role="menuitem"]')];
const MENU_MOTION_MS = 180; // .options-menu transition in app.css
let menuTimer = null;

/** Avatar initial and name of the signed-in user. */
function renderUserButton() {
  const name = state.me?.user?.username || '';
  $('#user-name').textContent = name;
  $('#user-avatar').textContent = name ? name[0].toLocaleUpperCase('pt-BR') : '?';
}

const menuOpen = () => menu.dataset.state === 'open';

/**
 * The menu stays in the DOM so it can fade out: "closing" keeps it painted for
 * the transition, then "closed" hides it (visibility) from pointers, tab order
 * and screen readers.
 */
function openMenu({ focus = 'first' } = {}) {
  clearTimeout(menuTimer);
  menu.dataset.state = 'open';
  menuButton.setAttribute('aria-expanded', 'true');
  const items = menuItems();
  (focus === 'last' ? items.at(-1) : items[0])?.focus();
}

function closeMenu({ restoreFocus = false, instant = false } = {}) {
  if (menu.dataset.state === 'closed') return;
  const wasOpen = menuOpen();
  menuButton.setAttribute('aria-expanded', 'false');
  clearTimeout(menuTimer);
  if (instant || !wasOpen || reducedMotionQuery.matches) menu.dataset.state = 'closed';
  else {
    menu.dataset.state = 'closing';
    menuTimer = setTimeout(() => { menu.dataset.state = 'closed'; }, MENU_MOTION_MS);
  }
  if (restoreFocus) menuButton.focus();
}

menuButton.addEventListener('click', (event) => {
  event.stopPropagation();
  if (menuOpen()) closeMenu();
  else openMenu();
});

menuButton.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  openMenu({ focus: event.key === 'ArrowUp' ? 'last' : 'first' });
});

menu.addEventListener('keydown', (event) => {
  const items = menuItems();
  const index = items.indexOf(document.activeElement);
  const move = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 }[event.key];
  if (move !== undefined) {
    event.preventDefault();
    items[(move + items.length) % items.length].focus();
  } else if (event.key === 'Tab') {
    closeMenu();
  }
});

menu.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  closeMenu({ restoreFocus: action === 'sync' });
  if (action === 'sync') loadAccounts();
  if (action === 'settings') openSettings();
  if (action === 'logout') logout();
});

document.addEventListener('click', (event) => { if (menuOpen() && !event.target.closest('#user-menu')) closeMenu(); });
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !menuOpen()) return;
  closeMenu({ restoreFocus: true });
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
  if (!state.accounts.length) {
    list.replaceChildren();
    const empty = document.createElement('p');
    empty.className = 'list-empty';
    empty.textContent = 'Nenhuma conta aberta encontrada no Actual Budget. Crie uma conta no Actual e depois atualize a lista.';
    list.append(empty);
    return;
  }
  const items = state.accounts.map(accountItem);
  const current = [...list.children];
  const sameAccounts = current.length === items.length && items.every((item, index) => current[index].dataset.accountId === item.dataset.accountId);
  if (!sameAccounts) {
    list.replaceChildren(...items);
    return;
  }
  // Same accounts in the same order: update the existing buttons in place. Rebuilding
  // them would drop keyboard and screen reader focus (TalkBack) from the list whenever
  // a message arrives or the list refreshes.
  items.forEach((item, index) => {
    const existing = current[index];
    if (existing.getAttribute('aria-current') !== item.getAttribute('aria-current')) existing.setAttribute('aria-current', item.getAttribute('aria-current'));
    if (existing.innerHTML !== item.innerHTML) existing.replaceChildren(...item.childNodes);
  });
}

function accountItem(account) {
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
  return item;
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
  if (initial) focusComposer();
}

async function enterWorkspace(me) {
  resetSession();
  state.me = me;
  state.history = createHistory(storage, me.user.id);
  showScreen('workspace');
  renderUserButton();
  updateComposerHint();
  $('#empty-chat-text').textContent = 'Cada conta do Actual Budget tem a sua conversa. As movimentações enviadas em uma conversa são registradas somente naquela conta.';
  renderView();
  await loadAccounts({ initial: true });
}

/* ---------- Workspace: views and navigation ---------- */

function pushMobileState(view) {
  if (mobileQuery.matches) window.history.pushState({ financeChat: view }, '');
}

/**
 * Shows the pane for the current state. `navigated` marks a change the user asked
 * for (open a chat, go back, open settings): only then the mobile account list
 * slides and focus is moved to the new pane. `focusAccountId` is the account to
 * focus when going back to the list.
 */
function renderView({ navigated = false, focusAccountId = null } = {}) {
  const from = workspace.dataset.view;
  const view = viewFor({ mobile: mobileQuery.matches, selectedId: state.selectedId, settingsOpen: state.settingsOpen });
  workspace.dataset.view = view;
  app.dataset.view = view;
  // The list view (mobile only) hides the whole main pane with CSS, so its content
  // is kept as it was: the chat stays visible under the list while it slides in.
  if (view !== 'list') {
    $('#settings-panel').hidden = view !== 'settings';
    $('#chat').hidden = view !== 'chat';
    $('#empty-chat').hidden = view !== 'empty';
  }
  if (view === 'chat') renderChat();
  if (!navigated) return;
  animateSidebar(sidebarMotion({ mobile: mobileQuery.matches, reducedMotion: reducedMotionQuery.matches, from, to: view }));
  moveFocusTo(view, focusAccountId);
}

const SIDEBAR_MOTION_MS = 280; // the longest slide in app.css (in: 280ms, out: 220ms)
let sidebarMotionTimer = null;

/**
 * Purely visual. The state, the visible pane and the focus are already final when
 * it starts; the pane that is leaving stays painted on top (or below) for the
 * length of the slide, but `inert` takes it out of the accessibility tree and of
 * touch/keyboard interaction at once, so screen readers never wait for it.
 */
function animateSidebar(motion) {
  clearTimeout(sidebarMotionTimer);
  const leaving = workspace.querySelector('[data-leaving]');
  if (leaving) {
    leaving.inert = false;
    leaving.removeAttribute('aria-hidden');
    delete leaving.dataset.leaving;
  }
  delete workspace.dataset.motion;
  if (!motion) return;
  const pane = $(motion === 'sidebar-in' ? '.main-pane' : '.sidebar');
  pane.inert = true;
  pane.setAttribute('aria-hidden', 'true'); // same as inert, for older Android WebViews
  pane.dataset.leaving = '';
  workspace.dataset.motion = motion;
  sidebarMotionTimer = setTimeout(() => animateSidebar(null), SIDEBAR_MOTION_MS);
}

/** Where focus goes after a navigation, so it is not left on a button that just disappeared. */
function moveFocusTo(view, focusAccountId) {
  const active = document.activeElement;
  const lost = !active || active === document.body || active.closest('[inert]') || !active.getClientRects().length;
  if (!lost) return;
  let target = null;
  if (view === 'list') {
    target = (focusAccountId && $('#account-list').querySelector(`[data-account-id="${CSS.escape(focusAccountId)}"]`))
      || $('#account-list .account-item') || $('#sync-accounts');
  }
  if (view === 'chat') target = $('#chat-title');
  if (view === 'settings') target = $('#settings-title');
  target?.focus({ preventScroll: true });
}

function renderChat() {
  const account = currentAccount();
  if (!account) return;
  $('#chat-title').textContent = account.name;
  $('#chat-avatar').textContent = initials(account.name);
  const entries = state.history.load(account.id);
  renderedSignature = historySignature(entries);
  chatView.render(entries, {
    greeting: GREETING,
    liveActions: (entry) => liveActionsFor(account.id, entry),
  });
  syncBusyIndicators();
}

/* ---------- Other windows (desktop quick window, other tabs) ---------- */

let renderedSignature = '';
const historySignature = (entries) => entries.map((entry) => `${entry.id}:${entry.status ?? ''}`).join('|');

/**
 * The quick window (or another tab) may have written to the history: the open
 * chat is redrawn only when its entries actually changed, and the account
 * list previews are refreshed.
 */
function refreshFromHistory() {
  if (app.dataset.screen !== 'workspace' || !state.history) return;
  renderAccountList();
  const account = currentAccount();
  if (account && isVisible(account.id) && historySignature(state.history.load(account.id)) !== renderedSignature) renderChat();
}
window.addEventListener('storage', (event) => {
  if (state.me && event.key?.startsWith(historyPrefix(state.me.user.id))) refreshFromHistory();
});
window.addEventListener('focus', refreshFromHistory);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshFromHistory(); });
// Desktop app: "Abrir na conversa" from the quick window opens that account's chat here.
listen('desktop://open-account', (payload) => {
  const accountId = payload?.accountId;
  if (accountId && state.accounts.some((account) => account.id === accountId)) selectAccount(accountId);
  else refreshFromHistory();
});

function selectAccount(accountId) {
  if (state.selectedId === accountId && !state.settingsOpen) return;
  voice.stop(); // dictation never continues into another chat
  const wasInList = !state.selectedId && !state.settingsOpen;
  state.selectedId = accountId;
  state.settingsOpen = false;
  if (wasInList) pushMobileState('chat');
  renderAccountList();
  renderView({ navigated: true });
  focusComposer();
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
  voice.stop();
  const leftAccountId = state.selectedId;
  if (state.settingsOpen) state.settingsOpen = false;
  else if (mobileQuery.matches) state.selectedId = null;
  renderAccountList();
  renderView({ navigated: true, focusAccountId: leftAccountId });
}

window.addEventListener('popstate', () => { if (app.dataset.screen === 'workspace') stepBack(); });
$('#back-to-list').addEventListener('click', () => goBack());
$('#sync-accounts').addEventListener('click', () => loadAccounts());
$('#account-list').addEventListener('click', (event) => {
  const item = event.target.closest('.account-item');
  if (item) selectAccount(item.dataset.accountId);
});
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

/** Buttons shown on a message while its action is still possible (never for restored history). */
function liveActionsFor(accountId, entry) {
  const item = state.live.get(entry.id);
  if (!item || item.accountId !== accountId) return undefined;
  if ((item.type === 'preview' || item.type === 'batch') && entry.kind === item.type && entry.status === 'pending') return previewActions(accountId, entry.id);
  if (item.type === 'clarify' && entry.kind === 'clarify' && entry.status === 'pending') return clarifyActions(accountId, entry.id, item);
  if (item.type === 'suggestions') return { suggestions: item.suggestions, onPick: (category) => pickSuggestion(accountId, entry.id, category) };
  if (item.type === 'undo') return { onUndo: () => undoLive(accountId, entry.id), ...(item.batch ? { undoLabel: 'Desfazer o lote inteiro' } : {}) };
  return undefined;
}

/** Removes one message's live action (and its buttons, if on screen). */
function removeLive(entryId) {
  state.live.delete(entryId);
  $('#conversation').querySelectorAll(`[data-live-entry="${entryId}"]`).forEach((row) => row.remove());
}

/** Stores the entry in this chat's local history and shows it if the chat is open. */
function addEntry(accountId, entry) {
  const full = { id: newEntryId(), at: Date.now(), ...entry };
  state.history?.append(accountId, full);
  if (isVisible(accountId)) chatView.append(full, { actions: liveActionsFor(accountId, full) });
  renderAccountList();
  return full;
}

/**
 * Removes live actions of these types from a chat. The server keeps one pending
 * preview per chat, so a new message makes older previews and suggestions stale.
 */
function retireLiveActions(accountId, types) {
  for (const [entryId, item] of state.live) if (item.accountId === accountId && types.includes(item.type)) state.live.delete(entryId);
  if (!isVisible(accountId)) return;
  for (const type of types) $('#conversation').querySelectorAll(`[data-live="${type}"]`).forEach((row) => row.remove());
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

/**
 * Shows one server answer in the chat. Every kind the API can return is
 * handled here: undo, category balance and simulation, single and batch
 * previews, clarifications of an AI draft, searches, plain texts, several
 * answers at once, and extra notes.
 */
function renderResponse(accountId, data) {
  const ai = data.source === 'ai';
  const base = { role: 'assistant', ...(ai ? { ai: true } : {}) };
  if (['clarify', 'transaction', 'batch'].includes(data.kind)) retireLiveActions(accountId, ['clarify']);

  if (data.kind === 'undo') {
    for (const [entryId, item] of state.live) {
      if (item.type === 'undo' && item.undoId === data.undoneId) {
        removeLive(entryId);
        markUndone(accountId, item.previewEntryId);
      }
    }
    addEntry(accountId, { role: 'assistant', kind: data.synced ? 'text' : 'warning', text: data.message });
  } else if (data.kind === 'category-available' || data.kind === 'text') {
    addEntry(accountId, { ...base, kind: 'text', text: data.message });
  } else if (data.kind === 'category-can-spend') {
    addEntry(accountId, {
      ...base, kind: 'spending', text: data.message,
      data: { category: data.category.name, available: data.available, requested: data.requested, remaining: data.remaining, canSpend: data.canSpend },
    });
  } else if (data.kind === 'transaction') {
    const entryId = newEntryId();
    state.live.set(entryId, { type: 'preview', accountId, pendingId: data.pendingId });
    addEntry(accountId, { ...base, id: entryId, kind: 'preview', text: PREVIEW_TEXT, status: 'pending', data: previewData(data.preview) });
    updateAccountName(data.preview.account);
  } else if (data.kind === 'batch') {
    const entryId = newEntryId();
    state.live.set(entryId, { type: 'batch', accountId, pendingId: data.pendingId });
    addEntry(accountId, { ...base, id: entryId, kind: 'batch', text: batchText(data.items.length), status: 'pending', data: batchData(data) });
    if (data.account) updateAccountName(data.account);
  } else if (data.kind === 'clarify') {
    const entryId = newEntryId();
    state.live.set(entryId, { type: 'clarify', accountId, draftId: data.draftId, missing: data.missing, categories: data.categories });
    addEntry(accountId, { ...base, id: entryId, kind: 'clarify', text: data.message, status: 'pending', data: { items: data.items, missing: data.missing } });
  } else if (data.kind === 'search') {
    addEntry(accountId, { ...base, kind: 'search', text: searchBubbleText(data), data: data.search });
  } else if (data.kind === 'summary') {
    addEntry(accountId, { ...base, kind: 'summary', text: summaryBubbleText(data), data: data.summary });
  } else if (data.kind === 'answers') {
    for (const answer of data.answers) renderResponse(accountId, { ...answer, source: data.source });
  } else {
    addEntry(accountId, { ...base, kind: 'text', text: data.message || 'Pronto.' });
  }
  for (const note of data.notes || []) addEntry(accountId, { role: 'assistant', kind: 'text', text: note });
}

/**
 * Sends a message of this chat. `categoryId` is set when the user picked a
 * suggested category; `echo` is the text shown as the user's message.
 */
async function sendMessage(accountId, message, { categoryId, echo = message } = {}) {
  if (state.busy.has(accountId)) return;
  retireLiveActions(accountId, ['preview', 'batch', 'suggestions']);
  addEntry(accountId, { role: 'user', kind: 'text', text: echo });
  setBusy(accountId, true);
  try {
    const data = await api('POST', '/api/chat/preview', { accountId, message, ...(categoryId ? { categoryId } : {}) });
    renderResponse(accountId, data);
  } catch (error) {
    if (error.suggestions.length) {
      const entryId = newEntryId();
      state.live.set(entryId, { type: 'suggestions', accountId, message, suggestions: error.suggestions });
      addEntry(accountId, { id: entryId, role: 'assistant', kind: 'error', text: error.message });
    } else {
      handleChatError(accountId, error);
    }
  } finally {
    setBusy(accountId, false);
    if (isVisible(accountId)) focusComposer();
  }
}

/** Buttons of an AI clarification: pick a category for a missing field, or discard the draft. */
function clarifyActions(accountId, entryId, item) {
  return {
    missing: item.missing,
    categories: item.categories,
    onChoose: (missing, category) => chooseDraftCategory(accountId, entryId, missing, category),
    onDiscard: () => discardDraft(accountId, entryId),
  };
}

/** Marks a clarification card with its final status and drops its buttons. */
function settleClarify(accountId, entryId, status) {
  removeLive(entryId);
  state.history?.update(accountId, entryId, { status });
  if (isVisible(accountId)) renderChat();
}

async function chooseDraftCategory(accountId, entryId, missing, category) {
  const item = state.live.get(entryId);
  if (!item || state.busy.has(accountId)) return;
  addEntry(accountId, { role: 'user', kind: 'text', text: `${missing.label}: ${category.name}` });
  setBusy(accountId, true);
  try {
    const data = await api('POST', '/api/chat/draft', { accountId, draftId: item.draftId, item: missing.item, part: missing.part, categoryId: category.id });
    settleClarify(accountId, entryId, 'done');
    renderResponse(accountId, data);
  } catch (error) {
    if (error.code === 'NO_DRAFT') settleClarify(accountId, entryId, 'cancelled');
    else if (isVisible(accountId)) renderChat();
    handleChatError(accountId, error);
  } finally {
    setBusy(accountId, false);
    if (isVisible(accountId)) focusComposer();
  }
}

async function discardDraft(accountId, entryId) {
  const item = state.live.get(entryId);
  if (!item || state.busy.has(accountId)) return;
  setBusy(accountId, true);
  try {
    const data = await api('POST', '/api/chat/cancel', { accountId, draftId: item.draftId });
    settleClarify(accountId, entryId, 'cancelled');
    addEntry(accountId, { role: 'assistant', kind: 'text', text: data.message });
  } catch (error) {
    handleChatError(accountId, error);
  } finally {
    setBusy(accountId, false);
  }
}

/** Dictation fills the field only; the message is sent with the usual button, after review. */
const voice = createVoiceInput({
  button: $('#voice-button'),
  input: messageInput,
  status: $('#voice-status'),
  announce: (text) => { $('#chat-announcer').replaceChildren(Object.assign(document.createElement('span'), { textContent: text })); },
});

$('#command-form').addEventListener('submit', (event) => {
  event.preventDefault();
  voice.stop();
  const accountId = state.selectedId;
  const text = messageInput.value.trim();
  if (!accountId || !text || state.busy.has(accountId)) return;
  messageInput.value = '';
  sendMessage(accountId, text);
});

/** Repeats the original message with the category the user picked. */
function pickSuggestion(accountId, entryId, category) {
  const item = state.live.get(entryId);
  if (!item || state.busy.has(accountId)) return;
  sendMessage(accountId, item.message, { categoryId: category.id, echo: `Usar a categoria “${category.name}”` });
}

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
    // A batch reports each item; an interrupted one is a warning, never something to resend blindly.
    const complete = data.kind !== 'batch' || data.complete;
    settlePreview(accountId, entryId, ui, complete ? 'confirmed' : 'partial');
    const success = { role: 'assistant', kind: complete && data.synced ? 'text' : 'warning', text: data.message };
    if (data.undoId) {
      // Only the last confirmation of a chat (one transaction or a whole batch) can be undone, for a few minutes.
      retireLiveActions(accountId, ['undo']);
      success.id = newEntryId();
      state.live.set(success.id, { type: 'undo', accountId, undoId: data.undoId, previewEntryId: entryId, batch: data.kind === 'batch' });
      setTimeout(() => removeLive(success.id), data.undoTtlMs ?? 10 * 60 * 1000);
    }
    addEntry(accountId, success);
    updateAccountName(data.account);
  } catch (error) {
    settlePreview(accountId, entryId, ui, 'failed');
    const text = error.code === 'NETWORK'
      ? `Não foi possível confirmar se ${item.type === 'batch' ? 'as movimentações foram registradas' : 'a movimentação foi registrada'}. Verifique no Actual Budget antes de enviar novamente.`
      : error.message;
    handleChatError(accountId, error, text);
  } finally {
    setBusy(accountId, false);
    if (isVisible(accountId)) focusComposer();
  }
}

/** Marks a preview card as undone, in history and on screen. */
function markUndone(accountId, previewEntryId) {
  state.history?.update(accountId, previewEntryId, { status: 'undone' });
  if (isVisible(accountId)) renderChat();
}

async function undoLive(accountId, successEntryId) {
  const item = state.live.get(successEntryId);
  if (!item || state.busy.has(accountId)) return;
  removeLive(successEntryId);
  setBusy(accountId, true);
  try {
    const data = await api('POST', '/api/chat/undo', { accountId, undoId: item.undoId });
    markUndone(accountId, item.previewEntryId);
    addEntry(accountId, { role: 'assistant', kind: data.synced ? 'text' : 'warning', text: data.message });
  } catch (error) {
    // Actual unreachable (or no answer): the server keeps the undo available, so the button comes back.
    if (error.code === 'ACTUAL_ERROR' || error.code === 'NETWORK') {
      state.live.set(successEntryId, item);
      if (isVisible(accountId)) renderChat();
    }
    handleChatError(accountId, error, error.code === 'NETWORK' ? 'Não foi possível confirmar se a movimentação foi desfeita. Verifique no Actual Budget.' : error.message);
  } finally {
    setBusy(accountId, false);
    if (isVisible(accountId)) focusComposer();
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
    addEntry(accountId, { role: 'assistant', kind: 'text', text: item.type === 'batch' ? 'Movimentações canceladas. Nada foi registrado.' : 'Movimentação cancelada.' });
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

/* ---------- Installable app (PWA) ---------- */

// Secure contexts only (HTTPS or localhost). The worker caches the interface files, never API data.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

boot();
