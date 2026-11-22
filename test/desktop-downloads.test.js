import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentDisposition, createDesktopDownloads, describeInstaller } from '../src/desktop-downloads.js';
import { ANA_CONNECTION, signedIn, startApp } from './support/app-harness.js';

const dir = mkdtempSync(join(tmpdir(), 'finance-chat-desktop-'));
const outside = mkdtempSync(join(tmpdir(), 'finance-chat-outside-'));
process.once('exit', () => { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
const EXE = 'Finance Chat_0.2.0_x64-setup.exe';
writeFileSync(join(dir, EXE), 'windows installer bytes');
writeFileSync(join(dir, 'Finance Chat_0.1.0_x64-setup.exe'), 'old version');
writeFileSync(join(dir, 'Finance Chat_0.2.0_x64_en-US.msi'), 'msi');
writeFileSync(join(dir, 'Finance Chat_0.2.0_aarch64.dmg'), 'dmg');
writeFileSync(join(dir, 'finance-chat_0.2.0_amd64.AppImage'), 'appimage');
writeFileSync(join(dir, 'finance-chat_0.2.0_amd64.deb'), 'deb');
writeFileSync(join(dir, 'notes.txt'), 'not an installer');
writeFileSync(join(dir, '.hidden.exe'), 'hidden');
mkdirSync(join(dir, 'nested.exe'));
writeFileSync(join(outside, 'secret.exe'), 'outside the directory');
symlinkSync(join(outside, 'secret.exe'), join(dir, 'link.exe'));

test('installer names produced by the Tauri bundler are recognized; anything else is not', () => {
  assert.deepEqual(describeInstaller(EXE), { platform: 'windows', format: 'exe', label: 'Instalador (.exe)', arch: 'x64', version: '0.2.0' });
  assert.equal(describeInstaller('Finance Chat_0.2.0_x64_en-US.msi').format, 'msi');
  assert.deepEqual(describeInstaller('Finance Chat_0.2.0_aarch64.dmg').arch, 'arm64');
  assert.equal(describeInstaller('finance-chat_0.2.0_amd64.AppImage').platform, 'linux');
  assert.equal(describeInstaller('finance-chat-0.2.0-1.x86_64.rpm').version, '0.2.0');
  assert.equal(describeInstaller('Finance Chat_0.3.0-beta.1_x64-setup.exe').version, '0.3.0-beta.1');
  for (const name of ['notes.txt', '.hidden.exe', '../secret.exe', 'a/b.exe', 'x..exe', '']) assert.equal(describeInstaller(name), null, name);
  assert.equal(contentDisposition('Finance Chat_ção.exe'), `attachment; filename="Finance Chat___o.exe"; filename*=UTF-8''Finance%20Chat_%C3%A7%C3%A3o.exe`);
});

test('the list has regular installer files only, newest version first per format, with SHA-256', async () => {
  const downloads = createDesktopDownloads({ dir });
  const { version, installers } = await downloads.list();
  assert.equal(version, '0.2.0');
  assert.deepEqual(installers.map((item) => item.name), [
    EXE, 'Finance Chat_0.1.0_x64-setup.exe', 'Finance Chat_0.2.0_x64_en-US.msi', 'Finance Chat_0.2.0_aarch64.dmg',
    'finance-chat_0.2.0_amd64.AppImage', 'finance-chat_0.2.0_amd64.deb',
  ]);
  assert.equal(installers[0].sha256, createHash('sha256').update('windows installer bytes').digest('hex'));
  assert.equal(installers[0].url, '/downloads/Finance%20Chat_0.2.0_x64-setup.exe');
  assert.equal(installers[0].size, 23);
  assert.deepEqual(await createDesktopDownloads({ dir: join(dir, 'missing') }).list(), { version: null, installers: [] });
});

test('downloads: signed-in users only, exact names, no traversal, no symlinks, no other files', async () => {
  const app = await startApp({ extraApp: { desktopDownloads: createDesktopDownloads({ dir }) } });
  const anonymous = app.client();
  assert.equal((await anonymous.get(`/downloads/${encodeURIComponent(EXE)}`)).status, 401);
  assert.equal((await anonymous.get('/api/desktop')).status, 401);

  const ana = await signedIn(app, 'ana', ANA_CONNECTION);
  const list = await ana.get('/api/desktop');
  assert.equal(list.status, 200);
  assert.equal(list.body.installers.length, 6);
  const file = await ana.get(list.body.installers[0].url);
  assert.equal(file.status, 200);
  assert.equal(file.text, 'windows installer bytes');
  assert.equal(file.headers.get('content-type'), 'application/octet-stream');
  assert.match(file.headers.get('content-disposition'), /^attachment; filename="Finance Chat_0.2.0_x64-setup.exe"/);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  for (const path of ['/downloads/link.exe', '/downloads/notes.txt', '/downloads/nested.exe', '/downloads/..%2F..%2Fpackage.json', '/downloads/%2e%2e%2fsecret.exe', '/downloads/%E0%A4%A']) {
    assert.equal((await ana.get(path)).status, 404, path);
  }
  await app.close();
});
