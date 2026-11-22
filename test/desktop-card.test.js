import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, downloadLabel, formatSize, installerSummary, recommendedInstaller } from '../public/js/desktop-card.js';

const installers = [
  { name: 'a.exe', platform: 'windows', format: 'exe', label: 'Instalador (.exe)', arch: 'x64', version: '0.2.0', size: 5_452_595 },
  { name: 'a.dmg', platform: 'macos', format: 'dmg', label: 'Imagem de disco (.dmg)', arch: 'arm64', version: '0.2.0', size: 900 },
];

test('the visitor platform picks the recommended installer', () => {
  assert.equal(detectPlatform({ userAgentData: { platform: 'Windows', mobile: false }, userAgent: '' }), 'windows');
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' }), 'macos');
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }), 'linux');
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' }), 'mobile');
  assert.equal(recommendedInstaller(installers, 'windows').name, 'a.exe');
  assert.equal(recommendedInstaller(installers, 'linux'), null);
  assert.equal(recommendedInstaller(installers, 'mobile'), null);
});

test('labels and sizes read well (and to screen readers)', () => {
  assert.equal(formatSize(5_452_595), '5,2 MB');
  assert.equal(formatSize(900), '1 KB');
  assert.equal(installerSummary(installers[0]), 'Windows · Instalador (.exe) · Intel/AMD 64 bits · versão 0.2.0 · 5,2 MB');
  assert.equal(downloadLabel(installers[0]), 'Baixar para Windows');
  assert.equal(downloadLabel(installers[1]), 'Baixar para macOS (Apple Silicon)');
});
