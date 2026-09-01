/**
 * Shared fetch helper with an AbortController-based timeout, extracted from
 * 9Router's Qoder OAuth service.
 *
 * Without a timeout, a stalled upstream socket hangs on Node's default
 * keepalive timeout (minutes) and abandoned polls accumulate hung sockets.
 */

export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/**
 * Merge AbortSignals using the native implementation when available, with a
 * small fallback for runtimes that do not expose AbortSignal.any despite the
 * package's Node engine declaration. The fallback preserves an existing
 * abort reason and handles already-aborted signals synchronously.
 */
function anySignal(signals) {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);

  const controller = new AbortController();
  const listeners = [];
  const cleanup = () => {
    for (const [signal, listener] of listeners) {
      signal.removeEventListener("abort", listener);
    }
    listeners.length = 0;
  };

  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      cleanup();
      controller.abort(signal.reason);
      break;
    }
    const listener = () => {
      cleanup();
      controller.abort(signal.reason);
    };
    listeners.push([signal, listener]);
    signal.addEventListener("abort", listener, { once: true });
  }
  return controller.signal;
}

export async function fetchWithTimeout(url, init = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  // Merge (not overwrite) the caller's signal so either the timeout or the
  // caller can cancel the fetch.
  const signal = init.signal ? anySignal([init.signal, controller.signal]) : controller.signal;
  try {
    return await fetchImpl(url, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Merge an external AbortSignal with a connect timeout. Returns the signal
 * to pass to fetch plus a cleanup fn that must be called after the response
 * headers arrive (or on error).
 */
export function withConnectTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("fetch connect timeout")), timeoutMs);
  const merged = signal ? anySignal([signal, controller.signal]) : controller.signal;
  return { signal: merged, cleanup: () => clearTimeout(timer) };
}
