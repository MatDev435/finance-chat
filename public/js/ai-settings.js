import { api } from './api.js';
import { formatUsd, modelHint, monthLabel, usageRows } from './ai-format.js';

/**
 * AI section of the settings: on/off switch (saved at once), OpenAI key and
 * model (saved with the button), explicit test and the usage summary.
 *
 * The typed key only lives in the password field until it is sent to the
 * server (authenticated, same-origin JSON); the field is cleared right after.
 * The server never sends a key back, so nothing here can ever display it.
 */
export function createAiSettings({ section, onChange }) {
  const toggle = section.querySelector('#ai-enabled');
  const form = section.querySelector('#ai-form');
  const fields = section.querySelector('#ai-fields');
  const keyInput = section.querySelector('#ai-key');
  const keyHint = section.querySelector('#ai-key-hint');
  const modelSelect = section.querySelector('#ai-model');
  const modelHintText = section.querySelector('#ai-model-hint');
  const status = section.querySelector('#ai-status');
  const testButton = section.querySelector('#ai-test');
  const saveButton = section.querySelector('#ai-save');
  const removeButton = section.querySelector('#ai-remove-key');
  const usageList = section.querySelector('#ai-usage');
  const usageNote = section.querySelector('#ai-usage-note');
  const defaultKeyHint = keyHint.textContent;
  const defaultUsageNote = usageNote.textContent;
  let models = [];
  let settings = null;
  let pricing = null;
  let busy = false;

  function setStatus(kind, text) {
    status.hidden = !text;
    status.className = `form-status ${kind}`;
    status.textContent = text || '';
  }

  function setBusy(value) {
    busy = value;
    toggle.disabled = value;
    testButton.disabled = value;
    saveButton.disabled = value;
    removeButton.disabled = value;
  }

  function renderSettings() {
    toggle.checked = settings.enabled;
    fields.disabled = !settings.enabled;
    removeButton.hidden = !settings.hasKey;
    keyInput.placeholder = settings.hasKey ? 'Chave salva (digite outra para substituir)' : 'sk-...';
    keyHint.textContent = settings.hasKey
      ? `Uma chave está salva${settings.keyUpdatedAt ? ` desde ${new Date(settings.keyUpdatedAt).toLocaleDateString('pt-BR')}` : ''}. Deixe em branco para mantê-la. Ela nunca é exibida.`
      : defaultKeyHint;
    if (models.some((model) => model.id === settings.model)) modelSelect.value = settings.model;
    renderModelHint();
  }

  function renderModelHint() {
    modelHintText.textContent = modelHint(models.find((model) => model.id === modelSelect.value));
  }

  function renderUsage(usage) {
    usageList.replaceChildren();
    const row = (label, value) => {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = value;
      usageList.append(dt, dd);
    };
    const current = models.find((model) => model.id === settings?.model);
    row('Modelo selecionado', current ? current.name : '—');
    if (usage) {
      row(`Custo estimado em ${monthLabel(usage.month)}`, formatUsd(usage.currentMonth.costNanoUsd));
      for (const [label, value] of usageRows(usage.total)) row(label === 'Custo estimado' ? 'Custo estimado acumulado' : label, value);
    }
    usageNote.textContent = pricing ? `${defaultUsageNote} Tabela de preços de ${pricing.version.split('-').reverse().join('/')}.` : defaultUsageNote;
  }

  async function load() {
    setStatus('info', '');
    try {
      const data = await api('GET', '/api/ai');
      models = data.models;
      settings = data.settings;
      modelSelect.replaceChildren(...models.map((model) => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.id === data.defaultModel ? `${model.name} (padrão)` : model.name;
        return option;
      }));
      pricing = data.pricing;
      renderSettings();
      renderUsage(data.usage);
    } catch (error) {
      setStatus('error', error.message);
    }
  }

  async function save(body, successText) {
    setBusy(true);
    try {
      const data = await api('PUT', '/api/ai/settings', body);
      settings = data.settings;
      keyInput.value = '';
      renderSettings();
      setStatus('success', successText(settings));
      onChange?.(settings);
      return true;
    } catch (error) {
      setStatus('error', error.message);
      if (error.field === 'apiKey') keyInput.focus();
      return false;
    } finally {
      setBusy(false);
    }
  }

  toggle.addEventListener('change', async () => {
    const enabled = toggle.checked;
    const saved = await save({ enabled }, (current) => {
      if (!current.enabled) return 'IA desativada. Nenhuma mensagem será enviada à OpenAI.';
      return current.hasKey ? 'IA ativada. Mensagens que o Finance Chat não entender sozinho serão interpretadas pelo modelo escolhido.' : 'IA ativada. Informe a chave de API da OpenAI e salve para começar a usar.';
    });
    if (!saved) toggle.checked = !enabled;
    else if (enabled && !settings.hasKey) keyInput.focus();
  });

  modelSelect.addEventListener('change', renderModelHint);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    const body = { model: modelSelect.value };
    if (keyInput.value.trim()) body.apiKey = keyInput.value;
    await save(body, (current) => (current.hasKey ? 'Configurações de IA salvas.' : 'Modelo salvo. Informe uma chave de API para usar a IA.'));
  });

  removeButton.addEventListener('click', async () => {
    if (busy) return;
    const removed = await save({ removeKey: true }, () => 'Chave removida. A IA fica inativa até você informar outra chave.');
    if (removed) keyInput.focus();
  });

  testButton.addEventListener('click', async () => {
    if (busy) return;
    const body = { model: modelSelect.value };
    if (keyInput.value.trim()) body.apiKey = keyInput.value;
    else if (!settings?.hasKey) {
      setStatus('error', 'Informe a chave de API da OpenAI para testar.');
      keyInput.focus();
      return;
    }
    setBusy(true);
    setStatus('info', 'Testando a chave e o modelo com a OpenAI...');
    try {
      const data = await api('POST', '/api/ai/test', body);
      setStatus('success', `${data.message}${keyInput.value.trim() ? ' Clique em Salvar para guardar a chave.' : ''}`);
      renderUsage(data.usage);
    } catch (error) {
      setStatus('error', error.message);
    } finally {
      setBusy(false);
    }
  });

  return { open: load };
}
