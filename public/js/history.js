/**
 * Visual-only chat history kept in localStorage: at most HISTORY_LIMIT
 * messages per chat, keyed by user id and Actual account id. It is never sent
 * to the server and never used for financial operations; Actual Budget is
 * the source of truth. Only whitelisted display fields are stored.
 */
export const HISTORY_LIMIT = 10;
const VERSION = 'v1';
const MAX_TEXT = 2000;
const ROLES = new Set(['user', 'assistant']);
const KINDS = new Set(['text', 'error', 'warning', 'preview', 'spending']);
const STATUSES = new Set(['pending', 'confirmed', 'cancelled', 'failed']);

export function historyPrefix(userId) {
  return `finance-chat:history:${VERSION}:${userId}:`;
}

export function historyKey(userId, accountId) {
  return `${historyPrefix(userId)}${accountId}`;
}

const text = (value, max = MAX_TEXT) => (typeof value === 'string' ? value.slice(0, max) : '');
const number = (value) => (Number.isFinite(value) ? value : null);

function sanitizeData(kind, data) {
  if (!data || typeof data !== 'object') return undefined;
  if (kind === 'preview') {
    return {
      type: data.type === 'income' ? 'income' : 'expense',
      amount: number(data.amount),
      description: text(data.description, 200),
      category: text(data.category, 200),
      account: text(data.account, 200),
      date: text(data.date, 10),
      ...(data.notes ? { notes: text(data.notes, 500) } : {}),
      ...(Array.isArray(data.parts) ? { parts: data.parts.slice(0, 10).map((part) => ({ category: text(part?.category, 200), amount: number(part?.amount) })) } : {}),
    };
  }
  if (kind === 'spending') {
    return {
      category: text(data.category, 200),
      available: number(data.available),
      requested: number(data.requested),
      remaining: number(data.remaining),
      canSpend: Boolean(data.canSpend),
    };
  }
  return undefined;
}

/** Returns a storable copy of an entry with only known fields, or null if it is not valid. */
export function sanitizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || !ROLES.has(entry.role) || !KINDS.has(entry.kind)) return null;
  const clean = {
    id: text(entry.id, 64) || `m${Date.now().toString(36)}`,
    role: entry.role,
    kind: entry.kind,
    text: text(entry.text),
    at: Number.isFinite(entry.at) ? entry.at : Date.now(),
  };
  const data = sanitizeData(entry.kind, entry.data);
  if (data) clean.data = data;
  if (STATUSES.has(entry.status)) clean.status = entry.status;
  return clean;
}

export function createHistory(storage, userId, { limit = HISTORY_LIMIT } = {}) {
  const prefix = historyPrefix(userId);
  const memory = new Map();

  function read(accountId) {
    const key = prefix + accountId;
    if (!storage) return memory.get(key) || [];
    try {
      const parsed = JSON.parse(storage.getItem(key) || '[]');
      return Array.isArray(parsed) ? parsed.map(sanitizeEntry).filter(Boolean).slice(-limit) : [];
    } catch {
      return [];
    }
  }

  function write(accountId, entries) {
    const key = prefix + accountId;
    const trimmed = entries.slice(-limit);
    if (!storage) {
      memory.set(key, trimmed);
      return trimmed;
    }
    try {
      storage.setItem(key, JSON.stringify(trimmed));
    } catch {
      // Storage full or blocked: history is a convenience, the chat keeps working.
    }
    return trimmed;
  }

  return {
    load: read,

    append(accountId, entry) {
      const clean = sanitizeEntry(entry);
      if (!clean) return read(accountId);
      return write(accountId, [...read(accountId), clean]);
    },

    update(accountId, entryId, patch) {
      return write(accountId, read(accountId).map((entry) => (entry.id === entryId ? sanitizeEntry({ ...entry, ...patch, id: entry.id }) || entry : entry)));
    },

    last(accountId) {
      return read(accountId).at(-1) || null;
    },

    /** Removes every chat history of this user from this browser. */
    clear() {
      memory.clear();
      if (!storage) return;
      try {
        const keys = [];
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key?.startsWith(prefix)) keys.push(key);
        }
        keys.forEach((key) => storage.removeItem(key));
      } catch {
        // Ignore storage errors.
      }
    },
  };
}

/** localStorage when usable, otherwise null (private mode, disabled storage). */
export function browserStorage() {
  try {
    const storage = globalThis.localStorage;
    const probe = '__finance_chat_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}
