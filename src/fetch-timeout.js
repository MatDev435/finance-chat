export const ACTUAL_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Gives every fetch() a deadline. Actual operations run one at a time (the
 * official API holds a single open budget per process), so a server that
 * accepts a connection and never answers would otherwise block every user.
 *
 * Must run before '@actual-app/api' is imported: the API keeps a reference to
 * globalThis.fetch at load time.
 */
export function installFetchTimeout(timeoutMs = ACTUAL_REQUEST_TIMEOUT_MS) {
  const original = globalThis.fetch;
  if (original.financeChatTimeout) return;
  const withTimeout = (input, init = {}) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    return original(input, { ...init, signal });
  };
  withTimeout.financeChatTimeout = true;
  globalThis.fetch = withTimeout;
}
