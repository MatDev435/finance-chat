/** Keyboard shortcuts of the quick window (pure, shared with the tests). */

/** Ctrl+Enter right after a preview appears is ignored for this long: a second Enter by reflex must not approve. */
export const APPROVE_GUARD_MS = 600;

/**
 * Maps a keydown to an action of the quick window, or null:
 * - Esc: hide the window (never cancels anything);
 * - Ctrl/⌘+Enter: approve the pending preview;
 * - Ctrl/⌘+1..3: pick a suggested category.
 * Plain Enter is the form's submit and is never mapped here.
 */
export function quickKeyAction(event) {
  const modifier = Boolean(event.ctrlKey || event.metaKey);
  if (event.isComposing) return null;
  if (event.key === 'Escape' && !modifier && !event.altKey && !event.shiftKey) return { type: 'hide' };
  if (event.key === 'Enter' && modifier && !event.altKey) return { type: 'approve' };
  const digit = /^Digit([1-3])$/.exec(event.code || '')?.[1] ?? (/^[1-3]$/.test(event.key) ? event.key : null);
  if (modifier && !event.altKey && !event.shiftKey && digit) return { type: 'pick', index: Number(digit) - 1 };
  return null;
}

export function canApprove(previewShownAt, now = Date.now()) {
  return now - previewShownAt >= APPROVE_GUARD_MS;
}

/** "Ctrl" or "⌘" for the shortcut hints, by platform. */
export function modifierLabel(platform = globalThis.navigator?.platform || '') {
  return /Mac|iPhone|iPad/i.test(platform) ? '⌘' : 'Ctrl';
}
