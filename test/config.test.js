import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { ConfigError, loadConfig } from '../src/config.js';

const secret = 'a'.repeat(43);

test('applies safe defaults', () => {
  const config = loadConfig({ APP_SECRET: secret });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3000);
  assert.equal(config.dataDir, resolve('./data'));
  assert.equal(config.databasePath, join(resolve('./data'), 'finance-chat.sqlite'));
  assert.equal(config.actualDataDir, join(resolve('./data'), 'actual'));
  assert.equal(config.cookieSecure, 'auto');
  assert.equal(config.trustProxy, false);
  assert.equal(config.allowSignup, false);
  assert.equal(config.timeZone, 'America/Sao_Paulo');
});

test('refuses to start without a strong APP_SECRET', () => {
  assert.throws(() => loadConfig({}), ConfigError);
  assert.throws(() => loadConfig({ APP_SECRET: 'short' }), /APP_SECRET/);
  assert.throws(() => loadConfig({ APP_SECRET: `replace-with-${'x'.repeat(40)}` }), /APP_SECRET/);
});

test('error messages never echo the secret value', () => {
  try {
    loadConfig({ APP_SECRET: 'my-weak-secret' });
    assert.fail('should throw');
  } catch (error) {
    assert.equal(error.message.includes('my-weak-secret'), false);
  }
});

test('validates port, cookie mode and time zone', () => {
  assert.throws(() => loadConfig({ APP_SECRET: secret, PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ APP_SECRET: secret, COOKIE_SECURE: 'maybe' }), /COOKIE_SECURE/);
  assert.throws(() => loadConfig({ APP_SECRET: secret, APP_TIME_ZONE: 'Mars/Base' }), /APP_TIME_ZONE/);
});

test('reads flags and data directory', () => {
  const config = loadConfig({ APP_SECRET: secret, TRUST_PROXY: 'true', ALLOW_SIGNUP: '1', DATA_DIR: '/var/lib/finance-chat', COOKIE_SECURE: 'TRUE' });
  assert.equal(config.trustProxy, true);
  assert.equal(config.allowSignup, true);
  assert.equal(config.cookieSecure, 'true');
  assert.equal(config.databasePath, '/var/lib/finance-chat/finance-chat.sqlite');
});
