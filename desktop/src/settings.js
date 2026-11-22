/** App settings window: server address, global shortcut, voice model and autostart. */
import { announce, invoke, listen } from './bridge.js';

const $ = (id) => document.getElementById(id);
const status = $('status');
let current = null;

function renderShortcutError(error) {
  $('shortcut-error').hidden = !error;
  $('shortcut-error').textContent = error || '';
}

function renderModels(models) {
  const box = $('models');
  box.replaceChildren(...models.map((model) => {
    const row = document.createElement('div');
    row.className = 'model';
    const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'voice-model', id: `model-${model.name}`, value: model.name });
    radio.checked = model.name === current.voiceModel;
    radio.setAttribute('aria-describedby', `model-${model.name}-state`);
    const label = Object.assign(document.createElement('label'), { htmlFor: radio.id, textContent: `${model.label} — ${model.size}` });
    const actions = document.createElement('div');
    actions.className = 'model-actions';
    const state = Object.assign(document.createElement('span'), { id: `model-${model.name}-state`, className: 'hint', textContent: model.downloaded ? 'Baixado.' : 'Ainda não baixado.' });
    actions.append(state);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = model.downloaded ? 'Apagar' : 'Baixar';
    button.setAttribute('aria-label', model.downloaded ? `Apagar o modelo ${model.label}` : `Baixar o modelo ${model.label}`);
    button.addEventListener('click', () => (model.downloaded ? removeModel(model) : downloadModel(model, button, actions)));
    actions.append(button);
    row.append(radio, label, actions);
    return row;
  }));
}

async function downloadModel(model, button, actions) {
  button.disabled = true;
  const progress = Object.assign(document.createElement('progress'), { max: 100, value: 0 });
  progress.setAttribute('aria-label', `Download do modelo ${model.label}`);
  actions.append(progress);
  let lastAnnounced = -1;
  const unlisten = await listen('voice://download', (payload) => {
    if (payload.model !== model.name || !payload.total) return;
    const percent = Math.floor((payload.received / payload.total) * 100);
    progress.value = percent;
    progress.setAttribute('aria-valuetext', `${percent}%`);
    // Announced every 25% only, so screen readers are not flooded.
    if (percent >= lastAnnounced + 25) {
      lastAnnounced = percent - (percent % 25);
      announce(status, `Baixando o modelo ${model.label}: ${percent}%.`);
    }
  });
  announce(status, `Baixando o modelo ${model.label}...`);
  try {
    await invoke('download_model', { name: model.name });
    announce(status, `Modelo ${model.label} baixado. A voz já pode ser usada.`, 'ok');
  } catch (error) {
    announce(status, String(error), 'error');
  } finally {
    unlisten();
    await load();
  }
}

async function removeModel(model) {
  try {
    await invoke('delete_model', { name: model.name });
    announce(status, `Modelo ${model.label} apagado.`, 'ok');
  } catch (error) {
    announce(status, String(error), 'error');
  }
  await load();
}

async function load() {
  current = await invoke('get_settings');
  $('version').textContent = `Versão ${current.version}.`;
  $('server-url').value = current.serverUrl || '';
  $('shortcut').replaceChildren(...current.shortcuts.map((item) => Object.assign(document.createElement('option'), { value: item.value, textContent: item.label })));
  $('shortcut').value = current.shortcut;
  renderShortcutError(current.shortcutError);
  $('voice').hidden = !current.voiceAvailable;
  $('voice-unavailable').hidden = current.voiceAvailable;
  if (current.voiceAvailable) renderModels(current.models);
  $('keep-model').replaceChildren(...current.keepModelOptions.map((item) => Object.assign(document.createElement('option'), { value: String(item.value), textContent: item.label })));
  $('keep-model').value = String(current.keepModelMinutes);
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
    const voiceModel = document.querySelector('input[name="voice-model"]:checked')?.value || current.voiceModel;
    const result = await invoke('save_settings', {
      input: {
        serverUrl: origin, shortcut: $('shortcut').value, voiceModel, sounds: $('sounds').checked,
        keepModelMinutes: Number($('keep-model').value), autostart: $('autostart').checked,
      },
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
