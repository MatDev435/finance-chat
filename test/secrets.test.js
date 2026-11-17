import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecretBox, deriveKey } from '../src/secrets.js';

const box = createSecretBox('s'.repeat(43));

test('round-trips a secret bound to its context', () => {
  const sealed = box.seal('senha-do-servidor', 'user:1:server_secret');
  assert.equal(sealed.includes('senha-do-servidor'), false);
  assert.equal(box.open(sealed, 'user:1:server_secret'), 'senha-do-servidor');
});

test('uses a fresh IV for every encryption', () => {
  assert.notEqual(box.seal('same', 'ctx'), box.seal('same', 'ctx'));
});

test('a value copied to another user or field does not decrypt', () => {
  const sealed = box.seal('segredo', 'user:1:server_secret');
  assert.throws(() => box.open(sealed, 'user:2:server_secret'), { code: 'SECRET_UNREADABLE' });
  assert.throws(() => box.open(sealed, 'user:1:encryption_password'), { code: 'SECRET_UNREADABLE' });
});

test('detects tampering and malformed values', () => {
  const sealed = box.seal('segredo', 'ctx');
  const parts = sealed.split('.');
  const flipped = Buffer.from(parts[2], 'base64url');
  flipped[0] ^= 1;
  assert.throws(() => box.open([parts[0], parts[1], flipped.toString('base64url'), parts[3]].join('.'), 'ctx'), { code: 'SECRET_UNREADABLE' });
  assert.throws(() => box.open('v1.a.b', 'ctx'), { code: 'SECRET_UNREADABLE' });
  assert.throws(() => box.open(null, 'ctx'), { code: 'SECRET_UNREADABLE' });
  assert.throws(() => box.open([parts[0], parts[1], parts[2], parts[3].slice(0, 8)].join('.'), 'ctx'), { code: 'SECRET_UNREADABLE' });
});

test('a different APP_SECRET cannot read stored values', () => {
  const sealed = box.seal('segredo', 'ctx');
  assert.throws(() => createSecretBox('t'.repeat(43)).open(sealed, 'ctx'), { code: 'SECRET_UNREADABLE' });
});

test('derived keys are independent per purpose', () => {
  const secret = 'k'.repeat(43);
  assert.notDeepEqual(deriveKey(secret, 'a'), deriveKey(secret, 'b'));
  assert.equal(deriveKey(secret, 'a').length, 32);
});
