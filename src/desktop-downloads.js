/**
 * Installers of the desktop app (Tauri) offered in the settings. The server
 * administrator copies the build artifacts (desktop/README.md) into
 * DESKTOP_DIR (default: DATA_DIR/desktop); nothing is downloaded or built by
 * the server. Only regular files whose names look like installers are listed
 * or served: no subdirectories, no symbolic links, no other extensions, no
 * path separators. Each file is listed with its SHA-256 (cached by size and
 * modification time) so it can be checked after the download.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,199}$/;
const FORMATS = [
  { test: /\.msi$/i, platform: 'windows', format: 'msi', label: 'Pacote MSI' },
  { test: /\.exe$/i, platform: 'windows', format: 'exe', label: 'Instalador (.exe)' },
  { test: /\.dmg$/i, platform: 'macos', format: 'dmg', label: 'Imagem de disco (.dmg)' },
  { test: /\.AppImage$/i, platform: 'linux', format: 'appimage', label: 'AppImage (qualquer distribuição)' },
  { test: /\.deb$/i, platform: 'linux', format: 'deb', label: 'Pacote .deb (Debian, Ubuntu, Mint)' },
  { test: /\.rpm$/i, platform: 'linux', format: 'rpm', label: 'Pacote .rpm (Fedora, openSUSE)' },
];
const PLATFORM_ORDER = ['windows', 'macos', 'linux'];
const FORMAT_ORDER = ['exe', 'msi', 'dmg', 'appimage', 'deb', 'rpm'];

/** "Finance Chat_0.1.0_x64-setup.exe" → { platform, format, label, arch, version }, or null if it is not an installer. */
export function describeInstaller(name) {
  if (typeof name !== 'string' || !NAME.test(name) || name.includes('..')) return null;
  const kind = FORMATS.find((format) => format.test.test(name));
  if (!kind) return null;
  let arch = null;
  if (/(?:aarch64|arm64)/i.test(name)) arch = 'arm64';
  else if (/(?:x64|x86_64|amd64)/i.test(name)) arch = 'x64';
  else if (/(?:i686|x86)(?![_-]?64)/i.test(name)) arch = 'x86';
  const version = /(?:^|[_-])v?(\d+\.\d+\.\d+(?:-[A-Za-z][0-9A-Za-z.]*)?)(?=[_.-])/.exec(name)?.[1] ?? null;
  return { platform: kind.platform, format: kind.format, label: kind.label, arch, version };
}

/** 1.10.0 > 1.9.3 (pre-release tags compared as text). */
function compareVersions(a, b) {
  const [mainA, preA = ''] = a.split('-');
  const [mainB, preB = ''] = b.split('-');
  const partsA = mainA.split('.').map(Number);
  const partsB = mainB.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) if (partsA[index] !== partsB[index]) return partsA[index] - partsB[index];
  if (preA === preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  return preA < preB ? -1 : 1;
}

/** attachment; filename="Finance Chat_0.1.0_x64-setup.exe"; filename*=UTF-8''… */
export function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

export function createDesktopDownloads({ dir }) {
  const hashes = new Map();

  /** A regular file of the directory with an installer name, or null. */
  async function inspect(name) {
    const description = describeInstaller(name);
    if (!description || !dir) return null;
    const path = join(dir, name);
    let info;
    try {
      info = await lstat(path);
    } catch {
      return null;
    }
    if (!info.isFile()) return null;
    return { name, path, size: info.size, mtimeMs: info.mtimeMs, ...description };
  }

  async function hashOf(file) {
    const cached = hashes.get(file.name);
    if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) return cached.sha256;
    const value = await sha256(file.path);
    hashes.set(file.name, { size: file.size, mtimeMs: file.mtimeMs, sha256: value });
    return value;
  }

  return {
    /** { version, installers: [{ name, platform, format, label, arch, version, size, sha256, url }] } */
    async list() {
      let names = [];
      try {
        names = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
      } catch {
        return { version: null, installers: [] };
      }
      const files = (await Promise.all(names.map(inspect))).filter(Boolean);
      const installers = [];
      for (const file of files) {
        installers.push({
          name: file.name, platform: file.platform, format: file.format, label: file.label, arch: file.arch, version: file.version,
          size: file.size, sha256: await hashOf(file), url: `/downloads/${encodeURIComponent(file.name)}`,
        });
      }
      installers.sort((a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform)
        || FORMAT_ORDER.indexOf(a.format) - FORMAT_ORDER.indexOf(b.format)
        || (b.version && a.version ? compareVersions(b.version, a.version) : 0)
        || a.name.localeCompare(b.name));
      const versions = installers.map((item) => item.version).filter(Boolean).sort(compareVersions);
      return { version: versions.at(-1) ?? null, installers };
    },

    /** The file to stream for /downloads/<name>, or null (unknown, not an installer, not a regular file). */
    open: inspect,
  };
}
