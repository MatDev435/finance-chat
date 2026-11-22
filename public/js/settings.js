import { api } from './api.js';
import { createAiSettings } from './ai-settings.js';
import { createDesktopCard } from './desktop-card.js';

/** Settings panel: default account, connection summary, session. */
export function createSettings({ panel, onDefaultSaved, onAiChange, onEditConnection, onLogout, onClose }) {
  const form = panel.querySelector('#default-account-form');
  const select = panel.querySelector('#default-account-select');
  const missing = panel.querySelector('#default-missing');
  const status = panel.querySelector('#settings-status');
  const summary = panel.querySelector('#connection-summary');

  function setStatus(kind, text) {
    status.hidden = !text;
    status.className = `form-status ${kind}`;
    status.textContent = text || '';
  }

  function option(value, label) {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    return node;
  }

  function summaryRow(label, value) {
    const group = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    group.append(dt, dd);
    summary.append(group);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    setStatus('info', 'Salvando...');
    try {
      const { settings } = await api('PUT', '/api/settings', { defaultAccountId: select.value || null });
      missing.hidden = true;
      setStatus('success', settings.defaultAccountId ? 'Pronto! Essa conta será aberta quando você entrar.' : 'Pronto! A lista de contas será exibida quando você entrar.');
      onDefaultSaved(settings);
    } catch (error) {
      setStatus('error', error.message);
    } finally {
      button.disabled = false;
    }
  });

  const aiSettings = createAiSettings({ section: panel.querySelector('#ai-settings'), onChange: onAiChange });
  const desktopCard = createDesktopCard(panel.querySelector('#desktop-card'));

  panel.querySelector('#edit-connection').addEventListener('click', () => onEditConnection());
  panel.querySelector('#settings-logout').addEventListener('click', () => onLogout());
  panel.querySelector('#settings-back').addEventListener('click', () => onClose());

  return {
    open({ me, accounts }) {
      const defaultId = me.settings.defaultAccountId;
      const available = accounts.some((account) => account.id === defaultId);
      select.replaceChildren(option('', 'Nenhuma: mostrar a lista de contas'), ...accounts.map((account) => option(account.id, account.name)));
      select.value = available ? defaultId : '';
      missing.hidden = !defaultId || available;
      setStatus('info', '');

      summary.replaceChildren();
      const connection = me.connection;
      summaryRow('Servidor', connection.serverUrl);
      summaryRow('Sync ID', connection.syncId);
      summaryRow('Acesso', connection.authMethod === 'token' ? 'Chave de API' : 'Senha do servidor');
      summaryRow('Criptografia', connection.hasEncryptionPassword ? 'Senha salva' : 'Não usada');

      aiSettings.open();
      desktopCard.open();

      const user = panel.querySelector('#session-user');
      user.textContent = 'Conectado como ';
      const name = document.createElement('strong');
      name.textContent = me.user.username;
      user.append(name, '.');
    },
  };
}
