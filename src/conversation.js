import { randomUUID } from 'node:crypto';

export const CONTEXT_TTL_MS = 15 * 60 * 1000;

/**
 * Short-lived, structured conversation context, kept in memory per user and
 * account (one chat), like the pending previews. Two independent kinds:
 *
 * - draft: transactions interpreted by the AI that still miss data (a
 *   category, an amount). Nothing is written while it exists; it becomes a
 *   normal preview once complete.
 * - query: the filters (never the results) of the last search, so a follow-up
 *   ("e no total?") can reuse them.
 *
 * Instead of the chat history, only these compact structures are ever sent
 * to the model. Both expire, and a restart simply forgets them.
 */
export function createConversationStore({ now = Date.now, ttlMs = CONTEXT_TTL_MS } = {}) {
  const slots = new Map();
  const slotOf = (userId, accountId) => `${userId}\u0000${accountId}`;

  function prune() {
    const time = now();
    for (const [key, slot] of slots) {
      if (slot.draft && slot.draft.expiresAt <= time) slot.draft = null;
      if (slot.query && slot.query.expiresAt <= time) slot.query = null;
      if (!slot.draft && !slot.query) slots.delete(key);
    }
  }

  function slot(userId, accountId, create = false) {
    prune();
    const key = slotOf(userId, accountId);
    let current = slots.get(key);
    if (!current && create) {
      current = { draft: null, query: null };
      slots.set(key, current);
    }
    return current || null;
  }

  return {
    /** { id, items, missing, contextKey, expiresAt } or null. */
    getDraft(userId, accountId) {
      return slot(userId, accountId)?.draft ?? null;
    },

    /** Replaces the chat's draft (a new one gets a new id: buttons of an older draft stop working). */
    putDraft(userId, accountId, { items, missing = [], contextKey, id = randomUUID() }) {
      const draft = { id, items, missing, contextKey, expiresAt: now() + ttlMs };
      slot(userId, accountId, true).draft = draft;
      return draft;
    },

    clearDraft(userId, accountId) {
      const current = slot(userId, accountId);
      if (current) current.draft = null;
    },

    getQuery(userId, accountId) {
      return slot(userId, accountId)?.query?.filters ?? null;
    },

    putQuery(userId, accountId, filters) {
      slot(userId, accountId, true).query = { filters, expiresAt: now() + ttlMs };
    },

    clearQuery(userId, accountId) {
      const current = slot(userId, accountId);
      if (current) current.query = null;
    },

    get size() {
      prune();
      return slots.size;
    },
  };
}
