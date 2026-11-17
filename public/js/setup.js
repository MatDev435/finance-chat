import { api } from './api.js';

/** Guided Actual Budget connection form (first setup and later review). */
export function createSetup({ form, onSaved, onCancel, onLogout }) {
  const $ = (selector) => form.querySelector(selector);
  const fields = {
    serverUrl: form.elements.serverUrl,
    syncId: form.elements.syncId,
    serverSecret: form.elements.serverSecret,
    useEncryption: form.elements.useEncryption,
    encryptionPassword: form.elements.encryptionPassword,
  };
  const status = $('#setup-status');
  const testButton = $('#setup-test');
  const saveButton = $('#setup-save');
  const cancelButton = $('#setup-cancel');
  let saved = null;
  let editing = false;

  const authMethod = () => form.elements.authMethod.value;

  function setStatus(kind, text) {
    status.hidden = !text;
    status.className = `form-status ${kind}`;
    status.textContent = text || '';
  }

  function clearInvalid() {
    form.querySelectorAll('[aria-invalid="true"]').forEach((input) => input.removeAttribute('aria-invalid'));
  }

  function refreshHints() {
    const sameServer = editing && saved?.configured && fields.serverUrl.value.trim().replace(/\/+$/, '') === saved.serverUrl;
    const keepsSecret = sameServer && authMethod() === saved.authMethod;
    $('#secret-label').textContent = authMethod() === 'token' ? 'Chave de API' : 'Senha do servidor';
    $('#secret-hint').hidden = !keepsSecret;
    fields.serverSecret.placeholder = keepsSecret ? '••••••••' : '';
    const useEncryption = fields.useEncryption.checked;
    $('#encryption-field').hidden = !useEncryption;
    const keepsEncryption = sameServer && saved.hasEncryptionPassword && fields.syncId.value.trim() === saved.syncId;
    $('#encryption-hint').hidden = !keepsEncryption;
    fields.encryptionPassword.placeholder = keepsEncryption ? '••••••••' : '';
  }

  function values() {
    return {
      serverUrl: fields.serverUrl.value.trim(),
      syncId: fields.syncId.value.trim(),
      authMethod: authMethod(),
      serverSecret: fields.serverSecret.value,
      useEncryption: fields.useEncryption.checked,
      encryptionPassword: fields.useEncryption.checked ? fields.encryptionPassword.value : '',
    };
  }

  function setBusy(busy, label) {
    testButton.disabled = busy;
    saveButton.disabled = busy;
    if (busy) setStatus('info', label);
  }

  function showError(error) {
    setStatus('error', error.message);
    if (error.field && fields[error.field]) {
      fields[error.field].setAttribute('aria-invalid', 'true');
      fields[error.field].focus();
    }
  }

  async function run(method, path, label) {
    clearInvalid();
    setBusy(true, label);
    try {
      return await api(method, path, values());
    } catch (error) {
      showError(error);
      return null;
    } finally {
      testButton.disabled = false;
      saveButton.disabled = false;
    }
  }

  testButton.addEventListener('click', async () => {
    const result = await run('POST', '/api/connection/test', 'Testando a conexão com o Actual...');
    if (result) setStatus('success', result.message);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await run('PUT', '/api/connection', 'Testando e salvando a conexão...');
    if (result) {
      fields.serverSecret.value = '';
      fields.encryptionPassword.value = '';
      onSaved(result);
    }
  });

  form.addEventListener('input', refreshHints);
  form.addEventListener('change', refreshHints);
  cancelButton.addEventListener('click', () => onCancel());
  $('#setup-logout').addEventListener('click', () => onLogout());

  return {
    open({ connection, editing: isEditing = false, message = '' } = {}) {
      saved = connection || null;
      editing = Boolean(isEditing && connection?.configured);
      form.reset();
      clearInvalid();
      if (saved?.configured) {
        fields.serverUrl.value = saved.serverUrl;
        fields.syncId.value = saved.syncId;
        form.elements.authMethod.value = saved.authMethod;
        fields.useEncryption.checked = saved.hasEncryptionPassword;
      }
      $('#setup-title').textContent = editing ? 'Revisar conexão com o Actual' : 'Conectar ao Actual Budget';
      $('#setup-intro').textContent = editing
        ? 'Altere apenas o que for necessário. A conexão é testada antes de ser salva.'
        : 'Informe os dados do seu servidor Actual. Cada usuário do Finance Chat usa a própria conexão.';
      cancelButton.hidden = !editing;
      setStatus(message ? 'error' : 'info', message);
      refreshHints();
      (editing ? fields.serverSecret : fields.serverUrl).focus({ preventScroll: true });
    },
  };
}
