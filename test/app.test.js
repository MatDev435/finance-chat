import test from 'node:test';
import assert from 'node:assert/strict';
import { request as rawRequest } from 'node:http';
import { resolveDate } from '../src/dates.js';
import { currentLocalDate } from '../src/transaction-mapping.js';
import { ANA_CONNECTION, BIA_CONNECTION, signedIn, startApp } from './support/app-harness.js';


test('health is public; API routes require a session', async () => {
  const app = await startApp();
  const client = app.client();
  assert.equal((await client.get('/health')).status, 200);
  for (const [method, path] of [['GET', '/api/me'], ['GET', '/api/accounts'], ['POST', '/api/chat/preview'], ['POST', '/api/chat/confirm'], ['PUT', '/api/settings'], ['PUT', '/api/connection']]) {
    const response = await client.request(method, path, method === 'GET' ? {} : { body: {} });
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal(response.body.code, 'AUTH_REQUIRED');
  }
  await app.close();
});

test('sign-up sets HttpOnly, SameSite=Strict cookies; refresh token is scoped to the auth path', async () => {
  const app = await startApp();
  const client = app.client();
  const response = await client.post('/api/auth/register', { username: 'Ana', password: 'senha-forte-1' });
  assert.equal(response.status, 201);
  assert.deepEqual(response.body.user, { id: 1, username: 'ana' });
  const cookies = Object.fromEntries(response.setCookies.map((cookie) => [cookie.name, cookie.attrs]));
  assert.equal(cookies.fc_access.httponly, true);
  assert.equal(cookies.fc_access.samesite, 'Strict');
  assert.equal(cookies.fc_access.path, '/');
  assert.equal(cookies.fc_refresh.httponly, true);
  assert.equal(cookies.fc_refresh.path, '/api/auth');
  assert.ok(Number(cookies.fc_refresh['max-age']) > 29 * 24 * 3600, 'refresh cookie persists across browser restarts');
  assert.equal(cookies.fc_access.secure, undefined, 'plain HTTP without proxy: no Secure flag');
  const me = await client.get('/api/me');
  assert.deepEqual(me.body, {
    ok: true, user: { id: 1, username: 'ana' }, connection: { configured: false }, settings: { defaultAccountId: null },
    ai: { enabled: false, model: 'gpt-6-luna', hasKey: false, keyUpdatedAt: null },
  });
  await app.close();
});

test('cookies get the Secure flag behind an HTTPS reverse proxy', async () => {
  const app = await startApp();
  const response = await app.client().post('/api/auth/register', { username: 'ana', password: 'senha-forte-1' }, { headers: { 'x-forwarded-proto': 'https' } });
  assert.ok(response.setCookies.every((cookie) => cookie.attrs.secure === true));
  await app.close();
});

test('only the first user can sign up unless ALLOW_SIGNUP is enabled', async () => {
  const app = await startApp({ allowSignup: false });
  assert.equal((await app.client().get('/api/auth/options')).body.signupOpen, true);
  assert.equal((await app.client().post('/api/auth/register', { username: 'owner', password: 'senha-forte-1' })).status, 201);
  assert.equal((await app.client().get('/api/auth/options')).body.signupOpen, false);
  const second = await app.client().post('/api/auth/register', { username: 'intruder', password: 'senha-forte-1' });
  assert.equal(second.status, 403);
  assert.equal(second.body.code, 'SIGNUP_DISABLED');
  await app.close();
});

test('validates sign-up input and rejects duplicate usernames', async () => {
  const app = await startApp();
  const client = app.client();
  assert.equal((await client.post('/api/auth/register', { username: 'a', password: 'senha-forte-1' })).body.code, 'INVALID_INPUT');
  assert.equal((await client.post('/api/auth/register', { username: 'ana', password: 'curta' })).body.code, 'INVALID_INPUT');
  assert.equal((await client.post('/api/auth/register', { username: "ana' OR 1=1 --", password: 'senha-forte-1' })).body.code, 'INVALID_INPUT');
  assert.equal((await client.post('/api/auth/register', { username: 'ana', password: 'senha-forte-1' })).status, 201);
  assert.equal((await app.client().post('/api/auth/register', { username: 'ANA', password: 'senha-forte-1' })).status, 409);
  await app.close();
});

test('login, logout and signing in as another user in the same browser', async () => {
  const app = await startApp();
  await signedIn(app, 'ana');
  await signedIn(app, 'bia');
  const browser = app.client();
  assert.equal((await browser.post('/api/auth/login', { username: 'ana', password: 'errada-123' })).status, 401);
  assert.equal((await browser.post('/api/auth/login', { username: 'ana', password: 'senha-forte-1' })).status, 200);
  assert.equal((await browser.get('/api/me')).body.user.username, 'ana');
  const logout = await browser.post('/api/auth/logout');
  assert.equal(logout.status, 200);
  assert.ok(logout.setCookies.every((cookie) => cookie.attrs['max-age'] === '0'));
  assert.equal((await browser.get('/api/me')).status, 401);
  assert.equal((await browser.post('/api/auth/login', { username: 'bia', password: 'senha-forte-1' })).status, 200);
  assert.equal((await browser.get('/api/me')).body.user.username, 'bia');
  await app.close();
});

test('logout invalidates the old cookies even if someone kept a copy', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana');
  const stolen = new Map(browser.jar);
  await browser.post('/api/auth/logout');
  const thief = app.client();
  for (const [name, cookie] of stolen) thief.jar.set(name, cookie);
  assert.equal((await thief.get('/api/me')).status, 401);
  assert.equal((await thief.post('/api/auth/refresh')).status, 401);
  await app.close();
});

test('an expired access token is renewed with the refresh token, which rotates', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana');
  const firstRefresh = browser.jar.get('fc_refresh').value;
  browser.jar.delete('fc_access');
  assert.equal((await browser.get('/api/me')).status, 401);
  assert.equal((await browser.post('/api/auth/refresh')).status, 200);
  assert.notEqual(browser.jar.get('fc_refresh').value, firstRefresh);
  assert.equal((await browser.get('/api/me')).status, 200);
  await app.close();
});

test('refresh without a valid token clears cookies and asks for login', async () => {
  const app = await startApp();
  const browser = app.client();
  browser.jar.set('fc_refresh', { value: 'forged', path: '/api/auth' });
  const response = await browser.post('/api/auth/refresh');
  assert.equal(response.status, 401);
  assert.equal(response.body.code, 'SESSION_EXPIRED');
  await app.close();
});

test('repeated wrong passwords are rate limited per username', async () => {
  const app = await startApp();
  await signedIn(app, 'ana');
  const attacker = app.client();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await attacker.post('/api/auth/login', { username: 'ana', password: `wrong-${attempt}xx` })).status, 401);
  }
  const blocked = await attacker.post('/api/auth/login', { username: 'ana', password: 'senha-forte-1' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  await app.close();
});

test('state-changing requests from another site are rejected (CSRF)', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana', ANA_CONNECTION);
  const evilOrigin = await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'gastei 10 loja categoria alimentação' }, { headers: { origin: 'https://evil.example' } });
  assert.equal(evilOrigin.status, 403);
  const crossSite = await browser.post('/api/auth/logout', {}, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  const form = await browser.post('/api/chat/preview', 'accountId=acc-nubank', { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);
  assert.equal((await browser.get('/api/me')).status, 200, 'session still valid');
  await app.close();
});

test('the Actual connection is tested before saving and secrets never reach the browser', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana');
  const invalid = await browser.put('/api/connection', { ...ANA_CONNECTION, serverUrl: 'ftp://x' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.field, 'serverUrl');
  const wrongPassword = await browser.put('/api/connection', { ...ANA_CONNECTION, serverSecret: 'wrong' });
  assert.equal(wrongPassword.status, 503);
  assert.equal(wrongPassword.body.reason, 'authentication');
  assert.equal((await browser.get('/api/me')).body.connection.configured, false, 'failed test saves nothing');

  const tested = await browser.post('/api/connection/test', ANA_CONNECTION);
  assert.equal(tested.status, 200);
  assert.match(tested.body.message, /2 contas/);
  assert.equal((await browser.get('/api/me')).body.connection.configured, false, 'test alone saves nothing');

  const saved = await browser.put('/api/connection', ANA_CONNECTION);
  assert.equal(saved.status, 200);
  const me = await browser.get('/api/me');
  assert.deepEqual(me.body.connection, { configured: true, serverUrl: 'https://ana.example', syncId: 'sync-ana-0001', authMethod: 'password', hasEncryptionPassword: false });
  for (const response of [saved, me, tested]) assert.equal(response.text.includes('ana-server-pass'), false);
  const stored = app.db.prepare('SELECT server_secret FROM actual_connections').pluck().get();
  assert.equal(stored.includes('ana-server-pass'), false, 'encrypted at rest');
  await app.close();
});

test('editing the connection keeps the stored secret only for the same server', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana', ANA_CONNECTION);
  assert.equal((await browser.put('/api/connection', { ...ANA_CONNECTION, serverSecret: '' })).status, 200);
  const moved = await browser.put('/api/connection', { ...ANA_CONNECTION, serverUrl: 'https://bia.example', serverSecret: '' });
  assert.equal(moved.status, 400);
  assert.equal(moved.body.field, 'serverSecret');
  assert.equal((await browser.put('/api/connection', { ...ANA_CONNECTION, authMethod: 'token', serverSecret: 'ana-api-key' })).body.connection.authMethod, 'token');
  await app.close();
});

test('lists the open accounts of the user\'s own budget and reflects renames', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana', ANA_CONNECTION);
  assert.deepEqual((await browser.get('/api/accounts')).body.accounts, [{ id: 'acc-nubank', name: 'Nubank' }, { id: 'acc-inter', name: 'Inter' }]);
  app.servers['https://ana.example'].files['sync-ana-0001'].accounts[0].name = 'Nubank PF';
  assert.deepEqual((await browser.get('/api/accounts')).body.accounts[0], { id: 'acc-nubank', name: 'Nubank PF' });
  await app.close();
});

test('without a configured connection the chat asks for setup', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana');
  const response = await browser.get('/api/accounts');
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'CONNECTION_REQUIRED');
  await app.close();
});

test('a confirmed preview is written once, to the account of the chat', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana', ANA_CONNECTION);
  const budget = app.servers['https://ana.example'].files['sync-ana-0001'];
  const preview = await browser.post('/api/chat/preview', { accountId: 'acc-inter', message: 'Gastei 40 reais no mercado categoria alimentação' });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.kind, 'transaction');
  assert.equal(preview.body.preview.account.name, 'Inter');
  assert.equal(budget.transactions.length, 0, 'preview writes nothing');

  const confirm = await browser.post('/api/chat/confirm', { pendingId: preview.body.pendingId });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.synced, true);
  assert.match(confirm.body.message, /registrada com sucesso[\s\S]*Conta: Inter/);
  assert.deepEqual(budget.transactions.map((t) => [t.account, t.amount]), [['acc-inter', -4000]]);

  const again = await browser.post('/api/chat/confirm', { pendingId: preview.body.pendingId });
  assert.equal(again.status, 409);
  assert.equal(budget.transactions.length, 1, 'no duplicate on repeated confirmation');
  await app.close();
});

test('parallel confirmations of the same preview write only once', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana', ANA_CONNECTION);
  const budget = app.servers['https://ana.example'].files['sync-ana-0001'];
  const { body } = await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'gastei 5 padaria categoria alimentação' });
  const results = await Promise.all([1, 2, 3].map(() => browser.post('/api/chat/confirm', { pendingId: body.pendingId })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal(budget.transactions.length, 1);
  await app.close();
});

test('cancel discards the preview without writing', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana', ANA_CONNECTION);
  const { body } = await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'gastei 5 padaria categoria alimentação' });
  assert.equal((await browser.post('/api/chat/cancel', { pendingId: body.pendingId })).status, 200);
  assert.equal((await browser.post('/api/chat/confirm', { pendingId: body.pendingId })).status, 409);
  assert.equal(app.servers['https://ana.example'].files['sync-ana-0001'].transactions.length, 0);
  await app.close();
});

test('unavailable accounts and invalid messages fail clearly, writing nothing', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana', ANA_CONNECTION);
  const closed = await browser.post('/api/chat/preview', { accountId: 'acc-closed', message: 'gastei 5 padaria categoria alimentação' });
  assert.equal(closed.status, 409);
  assert.equal(closed.body.code, 'ACCOUNT_UNAVAILABLE');
  const invalid = await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'paguei 5 padaria categoria alimentação' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'INVALID_COMMAND');
  const unknownCategory = await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'Quanto tenho em Viagens?' });
  assert.equal(unknownCategory.status, 400);
  assert.match(unknownCategory.body.error, /Viagens/);
  const badId = await browser.post('/api/chat/preview', { accountId: '../../etc', message: 'gastei 5 padaria categoria alimentação' });
  assert.equal(badId.status, 400);
  assert.equal(app.servers['https://ana.example'].files['sync-ana-0001'].transactions.length, 0);
  await app.close();
});

test('an account deleted between preview and confirmation is never replaced by another', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana', ANA_CONNECTION);
  const budget = app.servers['https://ana.example'].files['sync-ana-0001'];
  const { body } = await browser.post('/api/chat/preview', { accountId: 'acc-inter', message: 'gastei 5 padaria categoria alimentação' });
  budget.accounts = budget.accounts.filter((account) => account.id !== 'acc-inter');
  const confirm = await browser.post('/api/chat/confirm', { pendingId: body.pendingId });
  assert.equal(confirm.status, 409);
  assert.equal(confirm.body.code, 'ACCOUNT_UNAVAILABLE');
  assert.match(confirm.body.error, /Nada foi registrado/);
  assert.equal(budget.transactions.length, 0);
  await app.close();
});

test('changing the connection between preview and confirmation cancels the write', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana', ANA_CONNECTION);
  const { body } = await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'gastei 5 padaria categoria alimentação' });
  await browser.put('/api/connection', { ...ANA_CONNECTION, authMethod: 'token', serverSecret: 'ana-api-key' });
  const confirm = await browser.post('/api/chat/confirm', { pendingId: body.pendingId });
  assert.equal(confirm.status, 409);
  assert.equal(confirm.body.code, 'CONNECTION_CHANGED');
  assert.equal(app.servers['https://ana.example'].files['sync-ana-0001'].transactions.length, 0);
  await app.close();
});

test('a failed sync after writing is reported as a warning, not as an error to retry', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana', ANA_CONNECTION);
  const { body } = await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'gastei 5 padaria categoria alimentação' });
  app.api.hooks.beforeAdd = () => { app.api.hooks.beforeSync = () => { throw Object.assign(new Error('offline'), { code: 'network-failure' }); }; };
  const confirm = await browser.post('/api/chat/confirm', { pendingId: body.pendingId });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.synced, false);
  assert.match(confirm.body.message, /Não envie de novo/);
  await app.close();
});

test('Actual outages return a clear error and are logged without secrets', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana', ANA_CONNECTION);
  app.servers['https://ana.example'].offline = true;
  const response = await browser.get('/api/accounts');
  assert.equal(response.status, 503);
  assert.equal(response.body.reason, 'network');
  assert.ok(app.logs.length > 0);
  assert.equal(app.logs.join('\n').includes('ana-server-pass'), false);
  await app.close();
});

test('category questions still work inside any account chat', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana', ANA_CONNECTION);
  const response = await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'Quanto ainda tenho em Alimentação?' });
  assert.equal(response.status, 200);
  assert.equal(response.body.kind, 'category-available');
  assert.equal(response.body.available, 12345);
  await app.close();
});

test('users are fully isolated: budgets, previews, settings', async () => {
  const app = await startApp();
  const ana = await signedIn(app, 'ana', ANA_CONNECTION);
  const bia = await signedIn(app, 'bia', BIA_CONNECTION);

  const [anaAccounts, biaAccounts] = await Promise.all([ana.get('/api/accounts'), bia.get('/api/accounts')]);
  assert.deepEqual(anaAccounts.body.accounts.map((a) => a.id), ['acc-nubank', 'acc-inter']);
  assert.deepEqual(biaAccounts.body.accounts.map((a) => a.id), ['acc-carteira']);

  // Bia cannot use Ana's account id: it does not exist in Bia's budget.
  const crossAccount = await bia.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'gastei 5 padaria categoria alimentação' });
  assert.equal(crossAccount.status, 409);

  // Bia cannot confirm Ana's preview.
  const anaPreview = await ana.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'gastei 7 padaria categoria alimentação' });
  assert.equal((await bia.post('/api/chat/confirm', { pendingId: anaPreview.body.pendingId })).status, 409);
  assert.equal((await bia.post('/api/chat/cancel', { pendingId: anaPreview.body.pendingId })).status, 200);
  assert.equal((await ana.post('/api/chat/confirm', { pendingId: anaPreview.body.pendingId })).status, 200, 'Ana\'s preview survived Bia\'s attempts');

  // Settings are per user.
  await ana.put('/api/settings', { defaultAccountId: 'acc-inter' });
  assert.equal((await bia.get('/api/me')).body.settings.defaultAccountId, null);
  assert.equal((await bia.put('/api/settings', { defaultAccountId: 'acc-inter' })).status, 409);

  // Concurrent writes from both users land in their own budgets.
  const [p1, p2] = await Promise.all([
    ana.post('/api/chat/preview', { accountId: 'acc-inter', message: 'gastei 1 a categoria alimentação' }),
    bia.post('/api/chat/preview', { accountId: 'acc-carteira', message: 'gastei 2 b categoria alimentação' }),
  ]);
  await Promise.all([ana.post('/api/chat/confirm', { pendingId: p1.body.pendingId }), bia.post('/api/chat/confirm', { pendingId: p2.body.pendingId })]);
  const anaBudget = app.servers['https://ana.example'].files['sync-ana-0001'];
  const biaBudget = app.servers['https://bia.example'].files['sync-bia-0001'];
  assert.deepEqual(anaBudget.transactions.map((t) => t.account), ['acc-nubank', 'acc-inter']);
  assert.deepEqual(biaBudget.transactions.map((t) => t.account), ['acc-carteira']);
  await app.close();
});

test('default account preference: validated, persisted, survives renames, can be cleared', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana', ANA_CONNECTION);
  assert.equal((await browser.put('/api/settings', { defaultAccountId: 'acc-closed' })).status, 409, 'closed accounts cannot be default');
  assert.equal((await browser.put('/api/settings', { defaultAccountId: 'nope' })).status, 409);
  assert.equal((await browser.put('/api/settings', { defaultAccountId: 42 })).status, 400);
  assert.deepEqual((await browser.put('/api/settings', { defaultAccountId: 'acc-inter' })).body.settings, { defaultAccountId: 'acc-inter' });

  const budget = app.servers['https://ana.example'].files['sync-ana-0001'];
  budget.accounts[1].name = 'Inter PJ';
  assert.equal((await browser.get('/api/me')).body.settings.defaultAccountId, 'acc-inter');
  assert.equal((await browser.get('/api/accounts')).body.accounts.find((a) => a.id === 'acc-inter').name, 'Inter PJ');

  // A deleted default is kept as a preference (the UI shows it as unavailable) until the user changes it.
  budget.accounts.splice(1, 1);
  assert.equal((await browser.get('/api/me')).body.settings.defaultAccountId, 'acc-inter');
  assert.deepEqual((await browser.put('/api/settings', { defaultAccountId: null })).body.settings, { defaultAccountId: null });
  await app.close();
});

test('serves the frontend with security headers and blocks path traversal', async () => {
  const app = await startApp();
  const page = await app.client().get('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  const status = await new Promise((resolve) => {
    rawRequest(`${app.base}/..%2f..%2fpackage.json`, (response) => { response.resume(); resolve(response.statusCode); }).end();
  });
  assert.equal(status, 404);
  assert.equal((await app.client().get('/.env')).status, 404);
  await app.close();
});

test('the quick window page is served at /quick; the CSP only adds the desktop app IPC to connect-src', async () => {
  const app = await startApp();
  const page = await app.client().get('/quick');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.text, /<title>Registro rápido — Finance Chat<\/title>/);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /connect-src 'self' ipc: http:\/\/ipc\.localhost;/);
  assert.match(csp, /script-src 'self';/);
  assert.equal((await app.client().get('/quick.css')).status, 200);
  assert.equal((await app.client().get('/quickx')).status, 404);
  await app.close();
});

test('oversized and malformed bodies are rejected', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana', ANA_CONNECTION);
  assert.equal((await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'x'.repeat(20_000) })).status, 413);
  assert.equal((await browser.post('/api/chat/preview', '{not json')).status, 400);
  assert.equal((await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'x'.repeat(501) })).status, 400);
  await app.close();
});

test('a date in the message sets the transaction date; future dates are refused', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana', ANA_CONNECTION);
  const budget = app.servers['https://ana.example'].files['sync-ana-0001'];
  const yesterday = resolveDate({ daysAgo: 1 }, currentLocalDate());
  const preview = await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'Ontem gastei 40 no mercado categoria alimentação' });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.preview.transaction.date, yesterday);
  assert.match(preview.body.preview.text, /Data: \d{2}\/\d{2}\/\d{4}/);
  const confirm = await browser.post('/api/chat/confirm', { pendingId: preview.body.pendingId });
  assert.match(confirm.body.message, /Data: /, 'success text mentions a date other than today');
  assert.equal(budget.transactions[0].date, yesterday);

  const today = await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'Gastei 5 na padaria categoria alimentação' });
  const todayConfirm = await browser.post('/api/chat/confirm', { pendingId: today.body.pendingId });
  assert.doesNotMatch(todayConfirm.body.message, /Data: /, 'usual message unchanged for today');

  const future = await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'Gastei 5 na padaria categoria alimentação 01/01/2999' });
  assert.equal(future.status, 400);
  assert.match(future.body.error, /futuro/);
  assert.equal(budget.transactions.length, 2);
  await app.close();
});

test('an unknown category returns suggestions; choosing one previews with that category', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana', ANA_CONNECTION);
  const typo = await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'Gastei 40 no mercado categoria alimetação' });
  assert.equal(typo.status, 400);
  assert.deepEqual(typo.body.suggestions, [{ id: 'cat-food', name: 'Alimentação' }]);
  assert.match(typo.body.error, /Você quis dizer: Alimentação\?/);

  const chosen = await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'Gastei 40 no mercado categoria alimetação', categoryId: 'cat-food' });
  assert.equal(chosen.status, 200);
  assert.equal(chosen.body.preview.category.name, 'Alimentação');
  assert.equal(chosen.body.preview.transaction.category, 'cat-food');

  const noAccent = await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'Gastei 40 no mercado categoria alimentacao' });
  assert.equal(noAccent.body.preview.category.name, 'Alimentação');

  const query = await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'Quanto tenho em Alimetação?' });
  assert.equal(query.status, 400);
  assert.equal(query.body.code, 'CATEGORY_NOT_FOUND');
  assert.deepEqual(query.body.suggestions, [{ id: 'cat-food', name: 'Alimentação' }]);
  const queryChosen = await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'Quanto tenho em Alimetação?', categoryId: 'cat-food' });
  assert.equal(queryChosen.body.available, 12345);

  assert.equal((await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'Gastei 4 x categoria alimentação', categoryId: '../x' })).status, 400);
  await app.close();
});

test('split purchases: preview lists the parts, confirmation writes one transaction with subtransactions', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana', ANA_CONNECTION);
  const budget = app.servers['https://ana.example'].files['sync-ana-0001'];
  const preview = await browser.post('/api/chat/preview', { accountId: 'acc-inter', message: 'Gastei 100 no mercado categorias 70 alimentação, 30 salário' });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.preview.category, null);
  assert.deepEqual(preview.body.preview.splits.map((s) => [s.category.name, s.amount]), [['Alimentação', 70], ['Salário', 30]]);
  assert.match(preview.body.preview.text, /Categorias: Alimentação \(R\$\s?70,00\), Salário \(R\$\s?30,00\)/);
  const confirm = await browser.post('/api/chat/confirm', { pendingId: preview.body.pendingId });
  assert.equal(confirm.status, 200);
  assert.match(confirm.body.message, /Categorias: Alimentação/);
  assert.equal(budget.transactions.length, 1);
  assert.equal(budget.transactions[0].amount, -10000);
  assert.equal(budget.transactions[0].subtransactions.length, 2);

  const withChoice = await browser.post('/api/chat/preview', { accountId: 'acc-inter', message: 'Gastei 100 no mercado categorias 70 alimentação, 30 salário', categoryId: 'cat-food' });
  assert.equal(withChoice.status, 400);
  const unknown = await browser.post('/api/chat/preview', { accountId: 'acc-inter', message: 'Gastei 100 no mercado categorias 70 alimetação, 30 salário' });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /Você quis dizer: Alimentação/);
  assert.equal(unknown.body.suggestions, undefined);
  const wrongSum = await browser.post('/api/chat/preview', { accountId: 'acc-inter', message: 'Gastei 100 no mercado categorias 70 alimentação, 20 salário' });
  assert.equal(wrongSum.status, 400);
  assert.equal(budget.transactions.length, 1);
  await app.close();
});

test('undo: the last confirmed transaction of a chat can be undone once, by button or by typing "desfazer"', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana', ANA_CONNECTION);
  const budget = app.servers['https://ana.example'].files['sync-ana-0001'];
  const confirmOne = async (accountId, message) => {
    const preview = await browser.post('/api/chat/preview', { accountId, message });
    return (await browser.post('/api/chat/confirm', { pendingId: preview.body.pendingId })).body;
  };

  const first = await confirmOne('acc-nubank', 'Gastei 40 no mercado categoria alimentação');
  assert.ok(first.undoId);
  assert.ok(first.undoTtlMs > 9 * 60 * 1000);
  const undone = await browser.post('/api/chat/undo', { accountId: 'acc-nubank', undoId: first.undoId });
  assert.equal(undone.status, 200);
  assert.match(undone.body.message, /Movimentação desfeita: Despesa de R\$\s?40,00 para mercado/);
  assert.equal(budget.transactions.length, 0);
  assert.equal((await browser.post('/api/chat/undo', { accountId: 'acc-nubank', undoId: first.undoId })).body.code, 'NO_UNDO');

  // Only the most recent one per chat: the older one is no longer undoable.
  const a = await confirmOne('acc-nubank', 'Gastei 1 na banca categoria alimentação');
  const b = await confirmOne('acc-nubank', 'Gastei 2 na banca categoria alimentação');
  assert.equal((await browser.post('/api/chat/undo', { accountId: 'acc-nubank', undoId: a.undoId })).status, 409);
  const typed = await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'desfazer' });
  assert.equal(typed.status, 200);
  assert.equal(typed.body.kind, 'undo');
  assert.equal(typed.body.undoneId, b.undoId);
  assert.deepEqual(budget.transactions.map((t) => t.amount), [-100]);
  const nothing = await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'desfazer' });
  assert.equal(nothing.status, 409);
  assert.equal(nothing.body.code, 'NO_UNDO');

  // Undo is per chat: an undo id cannot be used from another chat (and stays valid in its own).
  const c = await confirmOne('acc-inter', 'Gastei 3 na banca categoria alimentação');
  assert.equal((await browser.post('/api/chat/undo', { accountId: 'acc-nubank', undoId: c.undoId })).status, 409);
  assert.equal((await browser.post('/api/chat/undo', { accountId: 'acc-inter', undoId: c.undoId })).status, 200);
  await app.close();
});

test('undo is refused when the transaction was changed in Actual, and for other users', async () => {
  const app = await startApp();
  const ana = await signedIn(app, 'ana', ANA_CONNECTION);
  const bia = await signedIn(app, 'bia', BIA_CONNECTION);
  const budget = app.servers['https://ana.example'].files['sync-ana-0001'];
  const preview = await ana.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'Gastei 40 no mercado categoria alimentação' });
  const confirm = (await ana.post('/api/chat/confirm', { pendingId: preview.body.pendingId })).body;

  assert.equal((await bia.post('/api/chat/undo', { accountId: 'acc-nubank', undoId: confirm.undoId })).status, 409, 'another user');
  budget.transactions[0].amount = -4100;
  const changed = await ana.post('/api/chat/undo', { accountId: 'acc-nubank', undoId: confirm.undoId });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'UNDO_CHANGED');
  assert.equal(budget.transactions.length, 1, 'never deletes a modified transaction');
  await app.close();
});

test('undo stays available when Actual is unreachable, and split purchases are undone whole', async () => {
  const app = await startApp();
  const browser = await signedIn(app, 'ana', ANA_CONNECTION);
  const budget = app.servers['https://ana.example'].files['sync-ana-0001'];
  const preview = await browser.post('/api/chat/preview', { accountId: 'acc-nubank', message: 'Gastei 100 no mercado categorias 70 alimentação, 30 salário' });
  const confirm = (await browser.post('/api/chat/confirm', { pendingId: preview.body.pendingId })).body;
  app.servers['https://ana.example'].offline = true;
  const offline = await browser.post('/api/chat/undo', { accountId: 'acc-nubank', undoId: confirm.undoId });
  assert.equal(offline.status, 503);
  assert.match(offline.body.error, /Nada foi desfeito/);
  app.servers['https://ana.example'].offline = false;
  assert.equal((await browser.post('/api/chat/undo', { accountId: 'acc-nubank', undoId: confirm.undoId })).status, 200);
  assert.equal(budget.transactions.length, 0);
  await app.close();
});

test('PWA: manifest, icons and service worker are served; the worker never handles the API', async () => {
  const app = await startApp();
  const client = app.client();
  const manifest = await client.get('/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get('content-type'), /application\/manifest\+json/);
  assert.equal(manifest.body.display, 'standalone');
  assert.equal(manifest.body.start_url, '/');
  const sizes = manifest.body.icons.map((icon) => `${icon.sizes}:${icon.purpose}`);
  assert.ok(sizes.includes('192x192:any') && sizes.includes('512x512:any') && sizes.includes('512x512:maskable'));
  for (const src of [...manifest.body.icons.map((icon) => icon.src), '/icons/apple-touch-icon.png']) {
    const icon = await fetch(app.base + src);
    assert.equal(icon.status, 200, src);
    assert.equal(icon.headers.get('content-type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await icon.arrayBuffer()).slice(1, 4)], [0x50, 0x4e, 0x47], `${src} is a PNG`);
  }

  const worker = await client.get('/sw.js');
  assert.equal(worker.status, 200);
  assert.match(worker.headers.get('content-type'), /javascript/);
  assert.match(worker.text, /url\.pathname\.startsWith\('\/api\/'\)/, 'API requests bypass the worker');
  const shell = JSON.parse(worker.text.match(/const SHELL = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  for (const path of shell) assert.equal((await fetch(app.base + path)).status, 200, `cached shell file ${path} exists`);

  const page = await client.get('/');
  assert.match(page.text, /<link rel="manifest" href="\/manifest.webmanifest">/);
  assert.match(page.text, /apple-touch-icon/);
  await app.close();
});
