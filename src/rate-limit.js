/**
 * Small fixed-window counter kept in memory. Restarting the process resets it,
 * which is acceptable for basic brute-force protection on a self-hosted app.
 */
export function createRateLimiter({ limit, windowMs, now = Date.now, maxKeys = 10_000 }) {
  const entries = new Map();

  function prune(time) {
    if (entries.size <= maxKeys) return;
    for (const [key, entry] of entries) if (entry.resetAt <= time) entries.delete(key);
    // Still too many keys: drop the oldest windows first (Map keeps insertion order).
    for (const key of entries.keys()) {
      if (entries.size <= maxKeys) break;
      entries.delete(key);
    }
  }

  function current(key) {
    const time = now();
    let entry = entries.get(key);
    if (!entry || entry.resetAt <= time) {
      entry = { count: 0, resetAt: time + windowMs };
      entries.set(key, entry);
      prune(time);
    }
    return { entry, time };
  }

  return {
    /** Returns whether another attempt is allowed, without counting it. */
    check(key) {
      const { entry, time } = current(key);
      return { allowed: entry.count < limit, retryAfterMs: Math.max(0, entry.resetAt - time) };
    },
    hit(key) {
      const { entry } = current(key);
      entry.count += 1;
      return entry.count;
    },
    reset(key) {
      entries.delete(key);
    },
    get size() {
      return entries.size;
    },
  };
}
