/** Pure navigation rules, shared by the UI and the tests. */

/**
 * Which chat opens when the app starts. Only the configured default account
 * is opened automatically; without it (or if it no longer exists) the user
 * picks a chat, so nothing is ever typed into an account by surprise.
 */
export function resolveInitialAccount({ accounts, defaultAccountId }) {
  if (!defaultAccountId) return { accountId: null, defaultMissing: false };
  const found = accounts.some((account) => account.id === defaultAccountId);
  return { accountId: found ? defaultAccountId : null, defaultMissing: !found };
}

/**
 * Keeps the selection only if the account still exists (by id) after the
 * list is refreshed; renamed accounts stay selected.
 */
export function reconcileSelection(accounts, selectedId) {
  return selectedId && accounts.some((account) => account.id === selectedId) ? selectedId : null;
}

/** Visible pane. On mobile one pane at a time; on desktop the list is always visible. */
export function viewFor({ mobile, selectedId, settingsOpen }) {
  if (settingsOpen) return 'settings';
  if (selectedId) return 'chat';
  return mobile ? 'list' : 'empty';
}

export function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const letters = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0];
  return letters.toLocaleUpperCase('pt-BR');
}

/** One-line summary of a history entry for the account list. */
export function entrySummary(entry) {
  if (!entry) return '';
  if (entry.kind === 'preview') {
    const value = Number(entry.data?.amount ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const label = entry.data?.type === 'income' ? 'Receita' : 'Despesa';
    const state = { confirmed: 'registrada', cancelled: 'cancelada', failed: 'não registrada', undone: 'desfeita' }[entry.status] || 'pendente';
    return `${label} de ${value} ${state}`;
  }
  const firstLine = String(entry.text || '').split('\n')[0];
  return entry.role === 'user' ? `Você: ${firstLine}` : firstLine;
}

/**
 * Slide of the account list on mobile when the visible pane changes: the list
 * enters from the left ('sidebar-in') or leaves to the left ('sidebar-out').
 * Desktop always shows the list, so it never animates; reduced motion disables it.
 */
export function sidebarMotion({ mobile, reducedMotion, from, to }) {
  if (!mobile || reducedMotion || !from || from === to) return null;
  if (to === 'list') return 'sidebar-in';
  if (from === 'list') return 'sidebar-out';
  return null;
}
