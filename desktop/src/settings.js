/** App settings window: server address, global shortcut, sound cues and autostart. */
import { announce, invoke } from './bridge.js';

const $ = (id) => document.getElementById(id);
const status = $('status');
let current = null;

function renderShortcutError(error) {
  $('shortcut-error').hidden = !error;
  $('shortcut-error').textContent = error || '';
}

async function load() {
  current = await invoke('get_settings');
  $('version').textContent = `Versão ${current.version}.`;
  $('server-url').value = current.serverUrl || '';
  $('shortcut').replaceChildren(...current.shortcuts.map((item) => Object.assign(document.createElement('option'), { value: item.value, textContent: item.label })));
  $('shortcut').value = current.shortcut;
  renderShortcutError(current.shortcutError);
  $('sounds').checked = current.sounds;
  $('autostart').checked = current.autostart;
}

$('settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('save');
  button.disabled = true;
  announce(status, 'Salvando...');
  try {
    const origin = await invoke('check_server', { url: $('server-url').value });
    const result = await invoke('save_settings', {
      input: { serverUrl: origin, shortcut: $('shortcut').value, sounds: $('sounds').checked, autostart: $('autostart').checked },
    });
    renderShortcutError(result.shortcutError);
    announce(status, result.restarting ? 'Salvo. O app vai reiniciar com o novo endereço.' : 'Configurações salvas.', result.shortcutError ? 'error' : 'ok');
    if (!result.restarting) await load();
  } catch (error) {
    announce(status, String(error), 'error');
  } finally {
    button.disabled = false;
  }
});

load().catch((error) => announce(status, String(error), 'error'));
