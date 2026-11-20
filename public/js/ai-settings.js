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
  const usageTotal = section.querySelector('#ai-usage-total');
  const monthLabelText = section.querySelector('#ai-usage-month-label');
  const monthCost = section.querySelector('#ai-usage-month-cost');
  const revealButton = section.querySelector('#ai-key-reveal');
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

  /** Icon (SVG paths) of each usage row in the panel; rows without one get none. */
  const USAGE_ICONS = {
    Chamadas: '<path d="m8 8-4 4 4 4"/><path d="m16 8 4 4-4 4"/><path d="m14 4-4 16"/>',
    'Tokens de entrada': '<path d="M12 4v16"/><path d="m6 14 6 6 6-6"/>',
    'Tokens de saída': '<path d="M12 20V4"/><path d="m6 10 6-6 6 6"/>',
    'Total de tokens': '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
    'Modelo selecionado': '<path d="M12 3c.6 4.6 3.4 7.4 8 8-4.6.6-7.4 3.4-8 8-.6-4.6-3.4-7.4-8-8 4.6-.6 7.4-3.4 8-8Z"/>',
  };

  function usageRow(list, label, value, withIcon) {
    const group = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    if (withIcon && USAGE_ICONS[label]) {
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = USAGE_ICONS[label]; // fixed markup from this file, never user data
      dt.append(icon);
    }
    dt.append(label);
    dd.textContent = value;
    group.append(dt, dd);
    list.append(group);
  }

  /** Month panel: highlighted cost and the month's rows (cost shown above, so not repeated); total in the details. */
  function renderUsage(usage) {
    usageList.replaceChildren();
    usageTotal.replaceChildren();
    const current = models.find((model) => model.id === settings?.model);
    if (usage) {
      monthLabelText.textContent = `Custo estimado em ${monthLabel(usage.month)}`;
      monthCost.textContent = formatUsd(usage.currentMonth.costNanoUsd);
      for (const [label, value] of usageRows(usage.currentMonth)) {
        if (label !== 'Custo estimado') usageRow(usageList, label, value, true);
      }
      for (const [label, value] of usageRows(usage.total)) usageRow(usageTotal, label === 'Custo estimado' ? 'Custo estimado acumulado' : label, value, false);
    }
    usageRow(usageList, 'Modelo selecionado', current ? current.name : '—', true);
    usageNote.textContent = pricing ? `${defaultUsageNote} Tabela de preços de ${pricing.version.split('-').reverse().join('/')}.` : defaultUsageNote;
  }

  /** Shows only what the user typed in this field: the saved key never comes back from the server. */
  function setRevealed(revealed) {
    keyInput.type = revealed ? 'text' : 'password';
    revealButton.setAttribute('aria-pressed', String(revealed));
    const label = revealed ? 'Ocultar a chave digitada' : 'Mostrar a chave digitada';
    revealButton.setAttribute('aria-label', label);
    revealButton.title = label;
  }
  revealButton.addEventListener('click', () => setRevealed(keyInput.type === 'password'));

  async function load() {
    setStatus('info', '');
    setRevealed(false);
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
      setRevealed(false);
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
