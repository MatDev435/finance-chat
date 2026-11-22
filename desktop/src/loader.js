/**
 * Loader of the main and quick windows: checks that the configured Finance Chat
 * answers, then opens it. Before the first setup (main window) it asks for the
 * address. Every state is announced through a role="status" line.
 */
import { announce, invoke, listen } from './bridge.js';

const windowName = document.querySelector('main').dataset.window;
const status = document.getElementById('status');
const errorActions = document.getElementById('error-actions');
const setup = document.getElementById('setup');

async function connect() {
  errorActions.hidden = true;
  const target = await invoke('loader_target', { window: windowName });
  if (!target.serverUrl) {
    showSetup();
    return;
  }
  status.hidden = false;
  status.className = 'status';
  status.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
  status.append(`Conectando a ${target.serverUrl}...`);
  try {
    await invoke('check_server', { url: target.serverUrl });
    window.location.replace(target.url);
  } catch (error) {
    announce(status, String(error), 'error');
    errorActions.hidden = false;
    document.getElementById('retry').focus();
  }
}

function showSetup(prefill = '') {
  if (!setup) return;
  status.hidden = true;
  errorActions.hidden = true;
  setup.hidden = false;
  const input = document.getElementById('server-url');
  input.value = prefill;
  input.focus();
}

document.getElementById('retry').addEventListener('click', connect);
document.getElementById('change').addEventListener('click', async () => {
  if (windowName === 'quick') {
    invoke('open_main', { accountId: null });
    return;
  }
  const target = await invoke('loader_target', { window: windowName });
  showSetup(target.serverUrl || '');
});

setup?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.getElementById('server-url');
  const setupStatus = document.getElementById('setup-status');
  const button = document.getElementById('connect');
  button.disabled = true;
  announce(setupStatus, 'Verificando o endereço...');
  try {
    const origin = await invoke('check_server', { url: input.value });
    const current = await invoke('get_settings');
    announce(setupStatus, 'Conectado! O app vai reiniciar para abrir o Finance Chat.', 'ok');
    await invoke('save_settings', {
      input: {
        serverUrl: origin, shortcut: current.shortcut, voiceModel: current.voiceModel, sounds: current.sounds,
        keepModelMinutes: current.keepModelMinutes, autostart: current.autostart,
      },
    });
  } catch (error) {
    announce(setupStatus, String(error), 'error');
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    button.disabled = false;
  }
});

// The quick window retries each time it is shown while the server was unreachable.
if (windowName === 'quick') listen('quick://shown', () => { if (!errorActions.hidden) connect(); });

connect();
