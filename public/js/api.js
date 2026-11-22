/**
 * JSON client for the Finance Chat API. Session cookies are HttpOnly, so the
 * page never sees tokens. When the short-lived access token expires (401),
 * the session is refreshed once and the request is repeated: the server
 * rejects unauthenticated requests before doing anything, so this repetition
 * cannot duplicate an operation. No other errors are retried.
 */
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || 'Não foi possível falar com o servidor do Finance Chat.');
    this.status = status;
    this.code = body?.code || (status === 0 ? 'NETWORK' : 'HTTP_ERROR');
    this.field = body?.field;
    this.reason = body?.reason;
    this.suggestions = Array.isArray(body?.suggestions) ? body.suggestions : [];
  }
}

let refreshing = null;
let sessionExpired = () => {};

export function onSessionExpired(handler) {
  sessionExpired = handler;
}

async function send(method, path, body, contentType = 'application/json') {
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (method !== 'GET') {
    init.headers['Content-Type'] = contentType;
    init.body = contentType === 'application/json' ? JSON.stringify(body ?? {}) : body;
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(0, { code: 'NETWORK', error: 'Sem conexão com o servidor do Finance Chat. Verifique sua internet.' });
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, data);
  return data;
}

/** Refreshes the session; concurrent callers (and other tabs, via Web Locks) share one refresh. */
export function refreshSession() {
  refreshing ??= (async () => {
    const run = () => send('POST', '/api/auth/refresh').then(() => true, () => false);
    return globalThis.navigator?.locks?.request ? navigator.locks.request('finance-chat-refresh', run) : run();
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export async function api(method, path, body, contentType) {
  try {
    return await send(method, path, body, contentType);
  } catch (error) {
    if (error.status !== 401 || path.startsWith('/api/auth/')) throw error;
    if (!(await refreshSession())) {
      sessionExpired();
      throw error;
    }
    try {
      return await send(method, path, body, contentType);
    } catch (retryError) {
      if (retryError.status === 401) sessionExpired();
      throw retryError;
    }
  }
}
