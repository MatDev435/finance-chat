/**
 * Quick window (/quick): one message at a time, opened by the desktop app's
 * global shortcut (Alt+Espaço) and usable in a browser too. It talks to the
 * same API as the chat and writes the exchange to the same local history,
 * so the main window shows it afterwards. Nothing is ever approved without
 * an explicit action: Ctrl/⌘+Enter (ignored right after the preview appears)
 * or the Aprovar button. Esc only hides the window.
 */
import { api, onSessionExpired } from './api.js';
import { createChatView, setPreviewStatus } from './chat-view.js';
import { isDesktop, invoke, listen, shortcutLabel } from './desktop-bridge.js';
import { PREVIEW_TEXT, batchData, batchText, previewData, searchBubbleText, summaryBubbleText } from './entry-data.js';
import { browserStorage, createHistory } from './history.js';
import { canApprove, modifierLabel, quickKeyAction } from './quick-keys.js';
import { createVoiceInput, mergeTranscript } from './voice.js';

const $ = (selector) => document.querySelector(selector);
const root = $('#quick');
const form = $('#quick-form');
const input = $('#quick-message');
const sendButton = $('#quick-send');
const voiceButton = $('#quick-voice');
const accountSelect = $('#quick-account');
const statusLine = $('#quick-status');
const actionsBox = $('#quick-actions');
const conversation = $('#quick-conversation');
const announcer = $('#quick-announcer');
const desktop = isDesktop();
const storage = browserStorage();
const chatView = createChatView({ conversation, typingIndicator: $('#quick-typing'), announcer });

const AUTO_HIDE_MS = 2500; // after a successful write (desktop only), long enough for the announcement
const STALE_MS = 10 * 60 * 1000; // a reopened window older than this starts clean (unless something is pending)

const state = {
  me: null,
  accounts: [],
  history: null,
  busy: false,
  /** entry id → { type: 'preview' | 'batch' | 'clarify' | 'suggestions' | 'undo', ... } (memory only) */
  live: new Map(),
  previewShownAt: 0,
  lastActivity: 0,
  hideTimer: null,
  shortcut: 'Alt+Space',
};
let counter = 0;
const newEntryId = () => `q${Date.now().toString(36)}${(counter += 1).toString(36)}`;
const accountKey = () => `finance-chat:quick:account:${state.me?.user.id}`;

/* ---------- Status, announcements and window size ---------- */

function announce(text) {
  if (text) announcer.replaceChildren(Object.assign(document.createElement('span'), { textContent: text }));
}

function setStatus(text, kind = '') {
  statusLine.textContent = text || '';
  statusLine.hidden = !text;
  statusLine.className = `quick-status${kind ? ` is-${kind}` : ''}`;
}

/** One optional action next to the status (e.g. "Abrir o Finance Chat"). */
function setStatusAction(label, onClick) {
  actionsBox.replaceChildren();
  actionsBox.hidden = !label;
  if (!label) return;
  const button = Object.assign(document.createElement('button'), { type: 'button', className: 'secondary-button', textContent: label });
  button.addEventListener('click', onClick);
  actionsBox.append(button);
}

let resizeFrame = 0;
/** The desktop window follows the content height (the app clamps it). */
function reportSize() {
  if (!desktop) return;
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    invoke('quick_resize', { height: Math.ceil(root.getBoundingClientRect().height) }).catch(() => {});
  });
}
if (typeof ResizeObserver === 'function') new ResizeObserver(reportSize).observe(root);

function hideWindow() {
  cancelAutoHide();
  if (desktop) invoke('quick_hide').catch(() => {});
}

function cancelAutoHide() {
  clearTimeout(state.hideTimer);
  state.hideTimer = null;
}

/* ---------- Entries and live actions ---------- */

function currentAccountId() {
  return accountSelect.value || null;
}

function liveActionsFor(entry) {
  const item = state.live.get(entry.id);
  if (!item) return undefined;
  if ((item.type === 'preview' || item.type === 'batch') && entry.status === 'pending') {
    return { onConfirm: (ui) => confirmPreview(entry.id, ui), onCancel: (ui) => cancelPreview(entry.id, ui) };
  }
  if (item.type === 'clarify' && entry.status === 'pending') {
    return {
      missing: item.missing,
      categories: item.categories,
      onChoose: (missing, category) => chooseDraftCategory(entry.id, missing, category),
      onDiscard: () => discardDraft(entry.id),
    };
  }
  if (item.type === 'suggestions') return { suggestions: item.suggestions, onPick: (category) => pickSuggestion(entry.id, category) };
  if (item.type === 'undo') return { onUndo: () => undoLive(entry.id), ...(item.batch ? { undoLabel: 'Desfazer o lote inteiro' } : {}) };
  return undefined;
}

/** Stores the entry in the account's history (shared with the main window) and shows it here. */
function addEntry(entry, accountId = currentAccountId()) {
  const full = { id: newEntryId(), at: Date.now(), ...entry };
  state.history?.append(accountId, full);
  chatView.append(full, { actions: liveActionsFor(full) });
  state.lastActivity = Date.now();
  return full;
}

function removeLive(entryId) {
  state.live.delete(entryId);
  conversation.querySelectorAll(`[data-live-entry="${entryId}"]`).forEach((row) => row.remove());
}

/** A new message starts a new exchange: the window only shows the latest one (all of them stay in the history). */
function clearExchange() {
  state.live.clear();
  chatView.render([]);
}

function setBusy(busy) {
  state.busy = busy;
  chatView.setTyping(busy);
  sendButton.disabled = busy || !currentAccountId();
}

function pendingPreview() {
  return [...state.live.values()].some((item) => item.type === 'preview' || item.type === 'batch');
}

function errorEntry(error, text = error.message) {
  addEntry({ role: 'assistant', kind: 'error', text });
  if (error.code === 'CONNECTION_REQUIRED' || error.code === 'CONNECTION_UNREADABLE') {
    setStatus('A conexão com o Actual precisa ser revista na janela principal.', 'error');
    setStatusAction('Abrir o Finance Chat', openMain);
  }
}

/* ---------- Responses (same kinds as the chat) ---------- */

function renderResponse(data) {
  const base = { role: 'assistant', ...(data.source === 'ai' ? { ai: true } : {}) };
  if (data.kind === 'undo') {
    for (const [entryId, item] of state.live) {
      if (item.type === 'undo' && item.undoId === data.undoneId) {
        removeLive(entryId);
        state.history?.update(currentAccountId(), item.previewEntryId, { status: 'undone' });
      }
    }
    addEntry({ role: 'assistant', kind: data.synced ? 'text' : 'warning', text: data.message });
  } else if (data.kind === 'category-available' || data.kind === 'text') {
    addEntry({ ...base, kind: 'text', text: data.message });
  } else if (data.kind === 'category-can-spend') {
    addEntry({
      ...base, kind: 'spending', text: data.message,
      data: { category: data.category.name, available: data.available, requested: data.requested, remaining: data.remaining, canSpend: data.canSpend },
    });
  } else if (data.kind === 'transaction' || data.kind === 'batch') {
    const id = newEntryId();
    const type = data.kind === 'batch' ? 'batch' : 'preview';
    state.live.set(id, { type, pendingId: data.pendingId });
    state.previewShownAt = Date.now();
    addEntry(type === 'batch'
      ? { ...base, id, kind: 'batch', text: batchText(data.items.length), status: 'pending', data: batchData(data) }
      : { ...base, id, kind: 'preview', text: PREVIEW_TEXT, status: 'pending', data: previewData(data.preview) });
  } else if (data.kind === 'clarify') {
    const id = newEntryId();
    state.live.set(id, { type: 'clarify', draftId: data.draftId, missing: data.missing, categories: data.categories });
    addEntry({ ...base, id, kind: 'clarify', text: data.message, status: 'pending', data: { items: data.items, missing: data.missing } });
  } else if (data.kind === 'search') {
    addEntry({ ...base, kind: 'search', text: searchBubbleText(data), data: data.search });
  } else if (data.kind === 'summary') {
    addEntry({ ...base, kind: 'summary', text: summaryBubbleText(data), data: data.summary });
  } else if (data.kind === 'answers') {
    for (const answer of data.answers) renderResponse({ ...answer, source: data.source });
  } else {
    addEntry({ ...base, kind: 'text', text: data.message || 'Pronto.' });
  }
  for (const note of data.notes || []) addEntry({ role: 'assistant', kind: 'text', text: note });
  // Long answers (searches, summaries) are easier to read in the main window.
  const readable = (item) => item?.kind === 'search' || item?.kind === 'summary';
  if (readable(data) || (data.kind === 'answers' && data.answers.some(readable))) {
    const accountId = currentAccountId();
    setStatusAction('Abrir na conversa', () => openMain(accountId));
  }
}

async function sendMessage(message, { categoryId, echo = message } = {}) {
  const accountId = currentAccountId();
  if (state.busy || !accountId) return;
  cancelAutoHide();
  clearExchange();
  setStatus('');
  setStatusAction(null);
  addEntry({ role: 'user', kind: 'text', text: echo });
  setBusy(true);
  try {
    renderResponse(await api('POST', '/api/chat/preview', { accountId, message, ...(categoryId ? { categoryId } : {}) }));
  } catch (error) {
    if (error.suggestions?.length) {
      const id = newEntryId();
      state.live.set(id, { type: 'suggestions', message, suggestions: error.suggestions });
      addEntry({ id, role: 'assistant', kind: 'error', text: error.message });
    } else {
      errorEntry(error);
    }
  } finally {
    setBusy(false);
    input.focus({ preventScroll: true });
  }
}

/* ---------- Approve, cancel, clarify, suggestions, undo ---------- */

function settlePreview(entryId, ui, status) {
  state.history?.update(currentAccountId(), entryId, { status });
  if (ui.card.isConnected) {
    setPreviewStatus(ui.card, status);
    ui.row.remove();
  }
}

async function confirmPreview(entryId, ui) {
  const item = state.live.get(entryId);
  if (!item || state.busy) return;
  state.live.delete(entryId);
  ui.confirmButton.disabled = true;
  ui.cancelButton.disabled = true;
  ui.confirmButton.classList.add('is-loading');
  ui.confirmButton.innerHTML = '<span class="button-spinner" aria-hidden="true"></span><span>Processando...</span>';
  setBusy(true);
  try {
    const data = await api('POST', '/api/chat/confirm', { pendingId: item.pendingId });
    const complete = data.kind !== 'batch' || data.complete;
    settlePreview(entryId, ui, complete ? 'confirmed' : 'partial');
    const success = { role: 'assistant', kind: complete && data.synced ? 'text' : 'warning', text: data.message };
    if (data.undoId) {
      success.id = newEntryId();
      state.live.set(success.id, { type: 'undo', undoId: data.undoId, previewEntryId: entryId, batch: data.kind === 'batch' });
      setTimeout(() => removeLive(success.id), data.undoTtlMs ?? 10 * 60 * 1000);
    }
    addEntry(success);
    // A clean write hides the window by itself (desktop); anything to check keeps it open.
    if (desktop && complete && data.synced) {
      setStatus('Registrado. A janela vai se fechar; o desfazer continua disponível por 10 minutos.');
      state.hideTimer = setTimeout(hideWindow, AUTO_HIDE_MS);
    }
  } catch (error) {
    settlePreview(entryId, ui, 'failed');
    errorEntry(error, error.code === 'NETWORK'
      ? `Não foi possível confirmar se ${item.type === 'batch' ? 'as movimentações foram registradas' : 'a movimentação foi registrada'}. Verifique no Actual Budget antes de enviar novamente.`
      : error.message);
  } finally {
    setBusy(false);
    input.focus({ preventScroll: true });
  }
}

async function cancelPreview(entryId, ui) {
  const item = state.live.get(entryId);
  if (!item) return;
  state.live.delete(entryId);
  ui.confirmButton.disabled = true;
  ui.cancelButton.disabled = true;
  try {
    await api('POST', '/api/chat/cancel', { pendingId: item.pendingId });
  } catch {
    // It expires on the server anyway.
  } finally {
    settlePreview(entryId, ui, 'cancelled');
    addEntry({ role: 'assistant', kind: 'text', text: item.type === 'batch' ? 'Movimentações canceladas. Nada foi registrado.' : 'Movimentação cancelada.' });
    input.focus({ preventScroll: true });
  }
}

function settleClarify(entryId, status) {
  removeLive(entryId);
  state.history?.update(currentAccountId(), entryId, { status });
}

async function chooseDraftCategory(entryId, missing, category) {
  const item = state.live.get(entryId);
  if (!item || state.busy) return;
  addEntry({ role: 'user', kind: 'text', text: `${missing.label}: ${category.name}` });
  setBusy(true);
  try {
    const data = await api('POST', '/api/chat/draft', { accountId: currentAccountId(), draftId: item.draftId, item: missing.item, part: missing.part, categoryId: category.id });
    settleClarify(entryId, 'done');
    renderResponse(data);
  } catch (error) {
    if (error.code === 'NO_DRAFT') settleClarify(entryId, 'cancelled');
    errorEntry(error);
  } finally {
    setBusy(false);
    input.focus({ preventScroll: true });
  }
}

async function discardDraft(entryId) {
  const item = state.live.get(entryId);
  if (!item || state.busy) return;
  try {
    const data = await api('POST', '/api/chat/cancel', { accountId: currentAccountId(), draftId: item.draftId });
    settleClarify(entryId, 'cancelled');
    addEntry({ role: 'assistant', kind: 'text', text: data.message });
  } catch (error) {
    errorEntry(error);
  }
}

function pickSuggestion(entryId, category) {
  const item = state.live.get(entryId);
  if (!item || state.busy) return;
  sendMessage(item.message, { categoryId: category.id, echo: `Usar a categoria “${category.name}”` });
}

async function undoLive(entryId) {
  const item = state.live.get(entryId);
  if (!item || state.busy) return;
  cancelAutoHide();
  removeLive(entryId);
  setBusy(true);
  try {
    const data = await api('POST', '/api/chat/undo', { accountId: currentAccountId(), undoId: item.undoId });
    state.history?.update(currentAccountId(), item.previewEntryId, { status: 'undone' });
    addEntry({ role: 'assistant', kind: data.synced ? 'text' : 'warning', text: data.message });
  } catch (error) {
    errorEntry(error, error.code === 'NETWORK' ? 'Não foi possível confirmar se a movimentação foi desfeita. Verifique no Actual Budget.' : error.message);
  } finally {
    setBusy(false);
  }
}

/** Ctrl/⌘+Enter: the same path as clicking Aprovar on the pending card. */
function approveByKeyboard() {
  if (!pendingPreview() || state.busy) return;
  if (!canApprove(state.previewShownAt)) {
    announce('Confira a prévia antes de aprovar.');
    return;
  }
  conversation.querySelector('.message-actions[data-live="preview"] button:not(.secondary), .message-actions[data-live="batch"] button:not(.secondary)')?.click();
}

/** Ctrl/⌘+1..3: a suggested category of the first missing field (or of a typo). */
function pickByKeyboard(index) {
  for (const [entryId, item] of state.live) {
    if (item.type === 'clarify') {
      const missing = item.missing.find((field) => field.field === 'category' && field.suggestions?.length);
      const category = missing?.suggestions[index];
      if (category) chooseDraftCategory(entryId, missing, category);
      return;
    }
    if (item.type === 'suggestions' && item.suggestions[index]) {
      pickSuggestion(entryId, item.suggestions[index]);
      return;
    }
  }
}

/* ---------- Form and keyboard ---------- */

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || state.busy || !currentAccountId()) return;
  voice?.stop();
  input.value = '';
  sendMessage(text);
});

document.addEventListener('keydown', (event) => {
  // Any interaction keeps the window open.
  if (state.hideTimer && event.key !== 'Escape') cancelAutoHide();
  const action = quickKeyAction(event);
  if (!action) return;
  if (action.type === 'hide') {
    if (event.target === accountSelect) return; // let the native select close first
    event.preventDefault();
    if (desktop) hideWindow();
    else input.value = '';
  } else if (action.type === 'approve') {
    event.preventDefault();
    approveByKeyboard();
  } else if (action.type === 'pick') {
    event.preventDefault();
    pickByKeyboard(action.index);
  }
});
document.addEventListener('pointerdown', cancelAutoHide);

accountSelect.addEventListener('change', () => {
  try { storage?.setItem(accountKey(), accountSelect.value); } catch { /* optional */ }
  clearExchange();
  setStatus('');
  input.focus({ preventScroll: true });
});

/* ---------- Voice ---------- */

let voice = null;

function onVoiceState(payload) {
  const voiceState = payload?.state;
  voiceButton.classList.toggle('is-listening', voiceState === 'recording');
  voiceButton.setAttribute('aria-pressed', String(voiceState === 'recording'));
  voiceButton.setAttribute('aria-label', voiceState === 'recording' ? 'Parar e transcrever' : 'Ditar mensagem por voz');
  setStatusAction(null);
  if (voiceState === 'recording') {
    cancelAutoHide();
    setStatus(`Ouvindo... solte ${shortcutLabel(state.shortcut)} (ou clique no microfone) para transcrever.`, 'recording');
    announce('Ouvindo.');
  } else if (voiceState === 'transcribing') {
    setStatus('Transcrevendo no seu computador...');
    announce('Transcrevendo.');
  } else if (voiceState === 'done') {
    const text = String(payload.text || '').trim();
    if (!text) {
      setStatus('Não entendi nenhuma fala. Tente de novo.', 'error');
      announce('Não entendi nenhuma fala.');
      return;
    }
    input.value = mergeTranscript(input.value, text).slice(0, input.maxLength);
    setStatus('Pronto. Revise o texto e pressione Enter para enviar.');
    // The transcript is read back so screen reader users can check it before sending.
    announce(`Texto transcrito: ${text}. Revise e pressione Enter para enviar.`);
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  } else if (voiceState === 'model-missing') {
    setStatus('Para usar a voz, baixe o modelo de reconhecimento nas configurações do app.', 'error');
    setStatusAction('Abrir as configurações do app', () => invoke('open_settings').catch(() => {}));
    announce('O modelo de voz ainda não foi baixado.');
  } else if (voiceState === 'error') {
    setStatus(payload.message || 'Não foi possível usar a voz agora.', 'error');
    announce(payload.message || 'Não foi possível usar a voz agora.');
  } else {
    setStatus('');
  }
}

async function setupVoice() {
  if (desktop) {
    voiceButton.hidden = false;
    voiceButton.addEventListener('click', () => invoke('voice_toggle').catch((error) => onVoiceState({ state: 'error', message: String(error) })));
    await listen('voice://state', onVoiceState);
    return;
  }
  voice = createVoiceInput({ button: voiceButton, input, status: statusLine, announce });
}

/* ---------- Desktop window life cycle ---------- */

function openMain(accountId) {
  if (desktop) invoke('open_main', { accountId: typeof accountId === 'string' ? accountId : null }).catch(() => {});
  else window.location.assign('/');
}

/** The app shows the window (shortcut tap or hold): start clean if it was left long ago, focus the field. */
function onShown(payload) {
  cancelAutoHide();
  // Signed out (or not connected) when it was loaded: the user may have signed in since, in the main window.
  if (root.dataset.state === 'signed-out') {
    window.location.reload();
    return;
  }
  if (root.dataset.state === 'ready' && Date.now() - state.lastActivity > STALE_MS && !pendingPreview()) {
    clearExchange();
    if (payload?.mode !== 'voice') {
      setStatus('');
      setStatusAction(null);
    }
  }
  input.focus({ preventScroll: true });
  reportSize();
}

/* ---------- Boot ---------- */

function signedOut(message = 'Sua sessão expirou. Entre no Finance Chat pela janela principal e abra o registro rápido de novo.') {
  root.dataset.state = 'signed-out';
  input.disabled = true;
  sendButton.disabled = true;
  accountSelect.disabled = true;
  setStatus(message, 'error');
  setStatusAction('Abrir o Finance Chat', () => openMain());
  announce(message);
}

async function loadAccounts() {
  setStatus('Carregando contas do Actual...');
  try {
    const { accounts } = await api('GET', '/api/accounts');
    state.accounts = accounts;
    let remembered = null;
    try { remembered = storage?.getItem(accountKey()); } catch { /* optional */ }
    const preferred = [remembered, state.me.settings.defaultAccountId].find((id) => id && accounts.some((account) => account.id === id));
    accountSelect.replaceChildren(...accounts.map((account) => Object.assign(document.createElement('option'), { value: account.id, textContent: account.name })));
    if (preferred) accountSelect.value = preferred;
    accountSelect.disabled = !accounts.length;
    input.disabled = !accounts.length;
    sendButton.disabled = !accounts.length;
    setStatus(accounts.length ? '' : 'Nenhuma conta disponível no Actual Budget.', accounts.length ? '' : 'error');
    setStatusAction(null);
  } catch (error) {
    if (error.status === 401) return;
    setStatus(error.message, 'error');
    setStatusAction('Tentar de novo', loadAccounts);
  }
}

async function boot() {
  onSessionExpired(() => signedOut());
  const modifier = modifierLabel();
  await setupVoice();
  if (desktop) {
    try {
      const info = await invoke('desktop_info');
      state.shortcut = info?.shortcut || state.shortcut;
    } catch { /* older app: keep the default label */ }
    $('#quick-help').textContent = `Enter envia · ${modifier}+Enter aprova · Esc fecha · segure ${shortcutLabel(state.shortcut)} para falar`;
    await listen('quick://shown', onShown);
    invoke('quick_ready').catch(() => {});
  } else {
    $('#quick-help').textContent = `Enter envia · ${modifier}+Enter aprova`;
  }
  try {
    state.me = await api('GET', '/api/me');
  } catch (error) {
    if (error.status === 401) signedOut('Entre no Finance Chat pela janela principal para usar o registro rápido.');
    else {
      setStatus(error.message, 'error');
      setStatusAction('Tentar de novo', () => window.location.reload());
    }
    return;
  }
  if (!state.me.connection.configured) {
    signedOut('Conecte o Finance Chat ao Actual Budget na janela principal antes de usar o registro rápido.');
    return;
  }
  state.history = createHistory(storage, state.me.user.id);
  if (state.me.ai?.enabled && state.me.ai.hasKey) input.placeholder = 'Escreva como preferir: lançamentos, saldos ou buscas...';
  await loadAccounts();
  root.dataset.state = 'ready';
  input.focus({ preventScroll: true });
  reportSize();
}

boot();
