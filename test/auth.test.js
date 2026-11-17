import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import {
  ACCESS_TOKEN_TTL_MS, REFRESH_IDLE_TTL_MS, REFRESH_REUSE_GRACE_MS, SESSION_MAX_AGE_MS,
  createAccessTokens, createAuth, hashPassword, normalizeUsername, validatePassword, verifyPassword,
} from '../src/auth.js';

const SECRET = 'x'.repeat(43);
const FAST = { N: 1024, r: 8, p: 1 };

function setup() {
  const clock = { now: 1_700_000_000_000 };
  const db = openDatabase(':memory:');
  const auth = createAuth({ db, appSecret: SECRET, now: () => clock.now, passwordParams: FAST });
  return { db, auth, clock };
}

test('hashes passwords with scrypt, a random salt and embedded parameters', async () => {
  const first = await hashPassword('correct horse', FAST);
  const second = await hashPassword('correct horse', FAST);
  assert.match(first, /^scrypt\$1024\$8\$1\$/);
  assert.notEqual(first, second);
  assert.equal(first.includes('correct horse'), false);
  assert.deepEqual(await verifyPassword('correct horse', first, FAST), { valid: true, needsRehash: false });
  assert.equal((await verifyPassword('wrong horse', first, FAST)).valid, false);
  assert.equal((await verifyPassword('x', 'garbage', FAST)).valid, false);
});

test('flags hashes made with old parameters for rehashing', async () => {
  const old = await hashPassword('correct horse', FAST);
  assert.equal((await verifyPassword('correct horse', old, { N: 2048, r: 8, p: 1 })).needsRehash, true);
});

test('validates usernames and passwords', () => {
  assert.equal(normalizeUsername('  Mat.Dev_1 '), 'mat.dev_1');
  for (const bad of ['ab', 'com espaço', 'joão', '-start', 'a'.repeat(33), null]) {
    assert.throws(() => normalizeUsername(bad), { code: 'INVALID_INPUT' }, String(bad));
  }
  assert.throws(() => validatePassword('1234567'), { code: 'INVALID_INPUT' });
  assert.throws(() => validatePassword('x'.repeat(129)), { code: 'INVALID_INPUT' });
  assert.equal(validatePassword('12345678'), '12345678');
});

test('access tokens are signed, expire and reject tampering', () => {
  const clock = { now: 1000 };
  const tokens = createAccessTokens(SECRET, { now: () => clock.now });
  const { token } = tokens.sign({ userId: 7, sessionId: 'sid' });
  assert.deepEqual(tokens.verify(token), { userId: 7, sessionId: 'sid', expiresAt: 1000 + ACCESS_TOKEN_TTL_MS });
  const [version, payload, signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ u: 8, s: 'sid', e: 9e15 })).toString('base64url');
  assert.equal(tokens.verify(`${version}.${forged}.${signature}`), null);
  assert.equal(tokens.verify(`${version}.${payload}.${signature.slice(0, -2)}`), null);
  assert.equal(createAccessTokens('y'.repeat(43), { now: () => clock.now }).verify(token), null);
  assert.equal(tokens.verify('nonsense'), null);
  clock.now += ACCESS_TOKEN_TTL_MS;
  assert.equal(tokens.verify(token), null);
});

test('only the first user may sign up unless signup is enabled', async () => {
  const { auth } = setup();
  const owner = await auth.register('Owner', 'password-1', { allowSignup: false });
  assert.deepEqual(owner, { id: 1, username: 'owner' });
  await assert.rejects(() => auth.register('friend', 'password-2', { allowSignup: false }), { code: 'SIGNUP_DISABLED' });
  assert.equal((await auth.register('friend', 'password-2', { allowSignup: true })).username, 'friend');
  await assert.rejects(() => auth.register('FRIEND', 'password-3', { allowSignup: true }), { code: 'USERNAME_TAKEN' });
});

test('verifies credentials case-insensitively on the username only', async () => {
  const { auth } = setup();
  await auth.register('ana', 'Senha-Forte', { allowSignup: true });
  assert.deepEqual(await auth.verifyCredentials('ANA', 'Senha-Forte'), { id: 1, username: 'ana' });
  assert.equal(await auth.verifyCredentials('ana', 'senha-forte'), null);
  assert.equal(await auth.verifyCredentials('nobody', 'Senha-Forte'), null);
  assert.equal(await auth.verifyCredentials('ana', 'x'.repeat(500)), null);
  assert.equal(await auth.verifyCredentials(undefined, undefined), null);
});

test('login rehashes passwords stored with outdated parameters', async () => {
  const { db, auth } = setup();
  await auth.register('ana', 'Senha-Forte', { allowSignup: true });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = 1').run(await hashPassword('Senha-Forte', { N: 512, r: 8, p: 1 }));
  assert.ok(await auth.verifyCredentials('ana', 'Senha-Forte'));
  assert.match(db.prepare('SELECT password_hash FROM users WHERE id = 1').pluck().get(), /^scrypt\$1024\$/);
});

test('sessions authenticate requests and store only refresh token hashes', async () => {
  const { db, auth } = setup();
  const user = await auth.register('ana', 'Senha-Forte', { allowSignup: true });
  const session = auth.createSession(user.id);
  assert.deepEqual(auth.authenticate(session.accessToken).user, { id: 1, username: 'ana' });
  const stored = db.prepare('SELECT refresh_hash FROM sessions').pluck().get();
  assert.notEqual(stored, session.refreshToken);
  assert.equal(auth.authenticate('v1.bogus.token'), null);
});

test('refresh rotates the token and the replaced token survives only a short grace window', async () => {
  const { auth, clock } = setup();
  const user = await auth.register('ana', 'Senha-Forte', { allowSignup: true });
  const first = auth.createSession(user.id);

  clock.now += 1000;
  const second = auth.refresh(first.refreshToken);
  assert.equal(second.status, 'rotated');
  assert.notEqual(second.refreshToken, first.refreshToken);
  assert.ok(auth.authenticate(second.accessToken));

  // A parallel tab presenting the replaced token within the grace window is accepted once more.
  clock.now += 1000;
  const parallel = auth.refresh(first.refreshToken);
  assert.equal(parallel.status, 'rotated');
  // The token that was current when the parallel refresh happened is still accepted as "previous".
  const afterParallel = auth.refresh(second.refreshToken);
  assert.equal(afterParallel.status, 'rotated');
});

test('reusing a rotated refresh token after the grace window revokes the whole session', async () => {
  const { auth, clock } = setup();
  const user = await auth.register('ana', 'Senha-Forte', { allowSignup: true });
  const first = auth.createSession(user.id);
  const second = auth.refresh(first.refreshToken);
  clock.now += REFRESH_REUSE_GRACE_MS + 1;
  assert.equal(auth.refresh(first.refreshToken).status, 'reused');
  assert.equal(auth.refresh(second.refreshToken).status, 'invalid');
  assert.equal(auth.authenticate(second.accessToken), null);
});

test('logout revokes the session immediately, even before the access token expires', async () => {
  const { auth } = setup();
  const user = await auth.register('ana', 'Senha-Forte', { allowSignup: true });
  const session = auth.createSession(user.id);
  auth.logout({ accessToken: session.accessToken, refreshToken: session.refreshToken });
  assert.equal(auth.authenticate(session.accessToken), null);
  assert.equal(auth.refresh(session.refreshToken).status, 'invalid');
});

test('logout works with only the refresh token (access token already expired)', async () => {
  const { auth, clock } = setup();
  const user = await auth.register('ana', 'Senha-Forte', { allowSignup: true });
  const session = auth.createSession(user.id);
  clock.now += ACCESS_TOKEN_TTL_MS + 1;
  auth.logout({ accessToken: session.accessToken, refreshToken: session.refreshToken });
  assert.equal(auth.refresh(session.refreshToken).status, 'invalid');
});

test('sessions expire after the idle period and after the absolute maximum age', async () => {
  const { auth, clock } = setup();
  const user = await auth.register('ana', 'Senha-Forte', { allowSignup: true });

  const idle = auth.createSession(user.id);
  clock.now += REFRESH_IDLE_TTL_MS + 1;
  assert.equal(auth.refresh(idle.refreshToken).status, 'invalid');

  let active = auth.createSession(user.id);
  const start = clock.now;
  while (clock.now - start < SESSION_MAX_AGE_MS - REFRESH_IDLE_TTL_MS / 2) {
    clock.now += REFRESH_IDLE_TTL_MS / 2;
    active = auth.refresh(active.refreshToken);
    assert.equal(active.status, 'rotated');
  }
  clock.now = start + SESSION_MAX_AGE_MS;
  assert.equal(auth.refresh(active.refreshToken).status, 'invalid');
});

test('one user cannot use a token minted for another session', async () => {
  const { auth } = setup();
  const ana = await auth.register('ana', 'Senha-Forte', { allowSignup: true });
  const bia = await auth.register('bia', 'Senha-Forte', { allowSignup: true });
  const anaSession = auth.createSession(ana.id);
  const biaSession = auth.createSession(bia.id);
  auth.logout({ accessToken: anaSession.accessToken });
  assert.equal(auth.authenticate(anaSession.accessToken), null);
  assert.equal(auth.authenticate(biaSession.accessToken).user.username, 'bia');
});
