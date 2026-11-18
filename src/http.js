import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

export const JSON_LIMIT_BYTES = 16 * 1024;

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function applySecurityHeaders(response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
}

export function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(body));
}

/** Reads a small JSON object body. Requires the JSON content type (also a CSRF barrier for HTML forms). */
export async function readJson(request, limit = JSON_LIMIT_BYTES) {
  if (!/^application\/json\b/i.test(request.headers['content-type'] || '')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Envie os dados no formato JSON.');
  }
  const declared = Number(request.headers['content-length']);
  if (declared > limit) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Requisição grande demais.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Requisição grande demais.');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* handled below */ }
  throw new HttpError(400, 'INVALID_JSON', 'Dados inválidos.');
}

export function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!(name in cookies)) {
      try { cookies[name] = decodeURIComponent(value); } catch { cookies[name] = value; }
    }
  }
  return cookies;
}

export function serializeCookie(name, value, { maxAge, path = '/', secure = false, httpOnly = true, sameSite = 'Strict' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function forwardedValue(header) {
  return typeof header === 'string' ? header.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

/** Client address. Behind a trusted reverse proxy, the right-most X-Forwarded-For entry is the one the proxy added. */
export function clientIp(request, trustProxy) {
  if (trustProxy) {
    const forwarded = forwardedValue(request.headers['x-forwarded-for']);
    if (forwarded.length) return forwarded.at(-1);
  }
  return request.socket?.remoteAddress || 'unknown';
}

/**
 * Whether cookies should carry the Secure flag. In "auto" mode an
 * X-Forwarded-Proto: https header is honored: a spoofed value can only make
 * cookies stricter, never weaker.
 */
export function isSecureRequest(request, mode) {
  if (mode === 'true') return true;
  if (mode === 'false') return false;
  return Boolean(request.socket?.encrypted) || forwardedValue(request.headers['x-forwarded-proto'])[0] === 'https';
}

/** Rejects state-changing requests initiated by another site. */
export function isCrossSite(request, trustProxy) {
  const site = request.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = request.headers.origin;
  if (!origin) return false;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  const host = (trustProxy && forwardedValue(request.headers['x-forwarded-host'])[0]) || request.headers.host;
  return originHost !== host;
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

export async function serveStatic(request, response, publicDir, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const type = STATIC_TYPES[extname(requested)];
  const root = normalize(publicDir + sep);
  const file = normalize(join(publicDir, requested));
  if (!type || !file.startsWith(root)) return sendJson(response, 404, { ok: false, code: 'NOT_FOUND' });
  let body;
  try {
    body = await readFile(file);
  } catch {
    return sendJson(response, 404, { ok: false, code: 'NOT_FOUND' });
  }
  response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': body.length });
  response.end(request.method === 'HEAD' ? undefined : body);
}
