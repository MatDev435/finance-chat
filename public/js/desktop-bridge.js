/**
 * Bridge to the Finance Chat desktop app (Tauri 2) when this page runs inside
 * it. The app only grants this site a few commands (desktop/src-tauri/
 * permissions/site.toml): hide or resize the quick window, open the main
 * window, start or stop voice capture and read the app's settings summary.
 * In a normal browser every function is a harmless no-op.
 */
const tauri = () => globalThis.__TAURI__ ?? null;

export function isDesktop() {
  return typeof tauri()?.core?.invoke === 'function';
}

export function invoke(command, args) {
  if (!isDesktop()) return Promise.reject(new Error('Not running in the desktop app'));
  return tauri().core.invoke(command, args);
}

/** Subscribes to an app event; returns an unsubscribe function (a no-op outside the app). */
export async function listen(event, handler) {
  if (typeof tauri()?.event?.listen !== 'function') return () => {};
  return tauri().event.listen(event, (message) => handler(message.payload));
}

/** "Alt+Space" → "Alt+Espaço" (how the shortcut is shown and read to screen readers). */
export function shortcutLabel(shortcut) {
  return String(shortcut || '')
    .split('+')
    .map((part) => ({ Space: 'Espaço', CommandOrControl: 'Ctrl', Control: 'Ctrl', Super: 'Win', Shift: 'Shift', Alt: 'Alt' }[part] ?? part))
    .join('+');
}
