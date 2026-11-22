/** Tauri IPC for the bundled pages (window.__TAURI__ is injected by the app: withGlobalTauri). */
export const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
export const listen = (event, handler) => window.__TAURI__.event.listen(event, (message) => handler(message.payload));

/** Replaces the text of a role="status" element so screen readers announce it. */
export function announce(element, text, kind = '') {
  element.hidden = !text;
  element.className = `status${kind ? ` ${kind}` : ''}`;
  element.textContent = text || '';
}
