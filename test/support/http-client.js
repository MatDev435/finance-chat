/** Minimal browser-like client: keeps cookies (honoring Path) and sends JSON. */
export function createClient(baseUrl, { origin } = {}) {
  const jar = new Map();

  function cookieHeader(path) {
    return [...jar].filter(([, cookie]) => path.startsWith(cookie.path)).map(([name, cookie]) => `${name}=${cookie.value}`).join('; ');
  }

  function store(response) {
    const set = [];
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(';').map((part) => part.trim());
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      const attrs = Object.fromEntries(attributes.map((attribute) => {
        const [key, ...rest] = attribute.split('=');
        return [key.toLowerCase(), rest.length ? rest.join('=') : true];
      }));
      set.push({ name, value, attrs });
      if (attrs['max-age'] === '0' || value === '') jar.delete(name);
      else jar.set(name, { value, path: attrs.path || '/' });
    }
    return set;
  }

  async function request(method, path, { body, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };
    const cookie = cookieHeader(path);
    if (cookie) init.headers.cookie = cookie;
    if (origin && method !== 'GET') init.headers.origin ??= origin;
    if (body !== undefined) {
      init.headers['content-type'] ??= 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const response = await fetch(baseUrl + path, init);
    const setCookies = store(response);
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: response.status, headers: response.headers, body: json, text, setCookies };
  }

  return {
    jar,
    request,
    get: (path, options) => request('GET', path, options),
    post: (path, body = {}, options) => request('POST', path, { ...options, body }),
    put: (path, body = {}, options) => request('PUT', path, { ...options, body }),
  };
}
