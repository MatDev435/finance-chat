/**
 * Settings card "App para computador": installers offered by this server
 * (GET /api/desktop), with the one for the visitor's system first. Every
 * text is plain HTML text (labels, sizes, SHA-256), readable by screen readers.
 */
import { api } from './api.js';
import { invoke, isDesktop } from './desktop-bridge.js';

const PLATFORM_NAMES = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
const ARCH_NAMES = { x64: 'Intel/AMD 64 bits', arm64: 'ARM (Apple Silicon)', x86: '32 bits' };

/** 'windows' | 'macos' | 'linux' | 'mobile' | null, from the browser. */
export function detectPlatform(nav = globalThis.navigator) {
  const hint = nav?.userAgentData?.platform || '';
  const agent = nav?.userAgent || '';
  if (nav?.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(agent)) return 'mobile';
  const source = `${hint} ${agent}`;
  if (/Windows/i.test(source)) return 'windows';
  if (/mac/i.test(source)) return 'macos';
  if (/Linux|X11|CrOS/i.test(source)) return 'linux';
  return null;
}

/** The first installer for the platform (the server lists the preferred format and newest version first). */
export function recommendedInstaller(installers, platform) {
  return installers.find((item) => item.platform === platform) ?? null;
}

export function formatSize(bytes) {
  const megabytes = bytes / (1024 * 1024);
  if (megabytes >= 1) return `${megabytes.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
  return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('pt-BR')} KB`;
}

/** "Windows · Instalador (.exe) · Intel/AMD 64 bits · versão 0.2.0 · 5,2 MB" */
export function installerSummary(item) {
  return [PLATFORM_NAMES[item.platform], item.label, ARCH_NAMES[item.arch], item.version ? `versão ${item.version}` : null, formatSize(item.size)].filter(Boolean).join(' · ');
}

export function downloadLabel(item) {
  const arch = item.platform === 'macos' && item.arch ? ` (${item.arch === 'arm64' ? 'Apple Silicon' : 'Intel'})` : '';
  return `Baixar para ${PLATFORM_NAMES[item.platform]}${arch}`;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The download link checks the session first (refreshing it if needed), then lets the browser download the file. */
async function download(event, url) {
  event.preventDefault();
  try {
    await api('GET', '/api/desktop');
    window.location.assign(url);
  } catch {
    // The session expired: the app shows the login screen.
  }
}

export function createDesktopCard(section) {
  const status = section.querySelector('#desktop-status');
  const main = section.querySelector('#desktop-download');
  const others = section.querySelector('#desktop-others');
  const list = section.querySelector('#desktop-list');

  function link(item, className, text) {
    const anchor = element('a', className);
    anchor.href = item.url;
    anchor.addEventListener('click', (event) => download(event, item.url));
    if (text) anchor.append(text);
    return anchor;
  }

  return {
    async open() {
      status.textContent = 'Procurando instaladores...';
      main.hidden = true;
      others.hidden = true;
      let data;
      try {
        data = await api('GET', '/api/desktop');
      } catch (error) {
        status.textContent = error.message;
        return;
      }
      const platform = detectPlatform();
      const recommended = recommendedInstaller(data.installers, platform);
      let running = '';
      if (isDesktop()) {
        try {
          const info = await invoke('desktop_info');
          running = `Você já está usando o app para computador${info?.version ? ` (versão ${info.version})` : ''}. `;
        } catch {
          running = 'Você já está usando o app para computador. ';
        }
      }
      if (!data.installers.length) {
        status.textContent = `${running}Nenhum instalador foi publicado neste servidor ainda. O administrador pode gerá-los seguindo desktop/README.md.`;
        return;
      }
      if (recommended) {
        main.href = recommended.url;
        main.querySelector('span').textContent = downloadLabel(recommended);
        main.setAttribute('aria-describedby', 'desktop-status');
        main.onclick = (event) => download(event, recommended.url);
        main.hidden = false;
        status.textContent = `${running}${installerSummary(recommended)}.`;
      } else {
        const platforms = new Intl.ListFormat('pt-BR', { type: 'conjunction' }).format([...new Set(data.installers.map((item) => PLATFORM_NAMES[item.platform]))]);
        status.textContent = `${running}Disponível para ${platforms}. Escolha abaixo.`;
      }
      list.replaceChildren(...data.installers.map((item) => {
        const row = element('li', 'installer-item');
        row.append(link(item, 'installer-link', item.name), element('span', 'installer-meta', installerSummary(item)));
        const hash = element('span', 'installer-hash');
        hash.append('SHA-256: ', element('code', '', item.sha256));
        row.append(hash);
        return row;
      }));
      others.hidden = false;
      if (!recommended) others.open = true;
    },
  };
}
