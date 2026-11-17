import { randomUUID } from 'node:crypto';

export const PENDING_TTL_MS = 15 * 60 * 1000;

function pendingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Previews waiting for explicit confirmation, kept in memory. There is at most
 * one per user and account (a new preview replaces the previous one). Each has
 * a random id; taking it removes it before the write starts, so a repeated or
 * concurrent confirmation can never record the same transaction twice.
 */
export function createPendingStore({ now = Date.now, ttlMs = PENDING_TTL_MS } = {}) {
  const byId = new Map();
  const bySlot = new Map();
  const slotOf = (userId, accountId) => `${userId}\u0000${accountId}`;

  function remove(entry) {
    byId.delete(entry.id);
    if (bySlot.get(entry.slot) === entry.id) bySlot.delete(entry.slot);
  }

  function pruneExpired() {
    const time = now();
    for (const entry of byId.values()) if (entry.expiresAt <= time) remove(entry);
  }

  return {
    put(userId, accountId, data) {
      pruneExpired();
      const slot = slotOf(userId, accountId);
      const previous = byId.get(bySlot.get(slot));
      if (previous) remove(previous);
      const entry = { id: randomUUID(), slot, userId, accountId, data, expiresAt: now() + ttlMs };
      byId.set(entry.id, entry);
      bySlot.set(slot, entry.id);
      return { id: entry.id, expiresAt: entry.expiresAt };
    },

    /** Removes and returns the pending data. Only its owner can take it. */
    take(userId, id) {
      const entry = typeof id === 'string' ? byId.get(id) : undefined;
      if (!entry || entry.userId !== userId) {
        throw pendingError('NO_PENDING_TRANSACTION', 'Esta movimentação já foi confirmada, cancelada ou substituída por outra prévia.');
      }
      remove(entry);
      if (entry.expiresAt <= now()) {
        throw pendingError('PENDING_EXPIRED', 'Esta prévia expirou. Envie a mensagem novamente.');
      }
      return { ...entry.data, accountId: entry.accountId };
    },

    cancel(userId, id) {
      const entry = typeof id === 'string' ? byId.get(id) : undefined;
      if (!entry || entry.userId !== userId) return false;
      remove(entry);
      return true;
    },

    get size() {
      return byId.size;
    },
  };
}
