import { randomUUID } from 'node:crypto';

export const UNDO_TTL_MS = 10 * 60 * 1000;

function undoError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * The last transaction confirmed in each chat (user + account) can be undone
 * for a short time. Kept in memory: a restart simply ends the undo window.
 * begin() marks an entry as in progress so a double click cannot delete twice;
 * finish() consumes it and abort() makes it available again (e.g. Actual was
 * unreachable and nothing was deleted).
 */
export function createUndoStore({ now = Date.now, ttlMs = UNDO_TTL_MS } = {}) {
  const byId = new Map();
  const bySlot = new Map();
  const slotOf = (userId, accountId) => `${userId}\u0000${accountId}`;

  function remove(entry) {
    byId.delete(entry.id);
    if (bySlot.get(entry.slot) === entry.id) bySlot.delete(entry.slot);
  }

  function pruneExpired() {
    const time = now();
    for (const entry of byId.values()) if (entry.expiresAt <= time && !entry.busy) remove(entry);
  }

  return {
    put(userId, accountId, data) {
      pruneExpired();
      const slot = slotOf(userId, accountId);
      const previous = byId.get(bySlot.get(slot));
      if (previous) remove(previous);
      const entry = { id: randomUUID(), slot, userId, accountId, data, expiresAt: now() + ttlMs, busy: false };
      byId.set(entry.id, entry);
      bySlot.set(slot, entry.id);
      return { id: entry.id, expiresAt: entry.expiresAt };
    },

    /** Id of the chat's undoable transaction, or null. */
    latestId(userId, accountId) {
      const entry = byId.get(bySlot.get(slotOf(userId, accountId)));
      return entry && entry.expiresAt > now() ? entry.id : null;
    },

    begin(userId, id) {
      const entry = typeof id === 'string' ? byId.get(id) : undefined;
      if (!entry || entry.userId !== userId || entry.busy) {
        throw undoError('NO_UNDO', 'Não há movimentação recente para desfazer nesta conversa.');
      }
      if (entry.expiresAt <= now()) {
        remove(entry);
        throw undoError('UNDO_EXPIRED', 'O prazo para desfazer (10 minutos) terminou. Se precisar, apague a movimentação direto no Actual Budget.');
      }
      entry.busy = true;
      return { id: entry.id, accountId: entry.accountId, ...entry.data };
    },

    finish(id) {
      const entry = byId.get(id);
      if (entry) remove(entry);
    },

    abort(id) {
      const entry = byId.get(id);
      if (entry) entry.busy = false;
    },

    get size() {
      return byId.size;
    },
  };
}
