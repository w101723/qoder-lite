/**
 * Typed service errors and OpenAI-shaped error serialization.
 *
 * Every error that reaches the wire has the OpenAI shape:
 *   { "error": { "message", "type", "param", "code" } }
 *
 * The adapter key authenticates THIS service; a bad upstream Qoder
 * credential is an upstream failure, never a claim that the caller's key
 * was wrong.
 */

/** Redact credential-shaped substrings before anything is logged or sent. */
export function redactSecrets(text) {
  return String(text ?? "")
    .replace(/\b(pt|jt|dt)-[A-Za-z0-9+/_-]{4,}/g, "$1-[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]");
}

export class ServiceError extends Error {
  /**
   * @param {number} status   HTTP status code.
   * @param {string} message  Public, safe-to-send message.
   * @param {object} meta     { type, code, param } per the error contract.
   */
  constructor(status, message, { type, code, param = null } = {}) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
    this.errorType = type || "server_error";
    this.errorCode = code || "internal_error";
    this.errorParam = param;
  }

  toJSON() {
    return {
      error: {
        message: redactSecrets(this.message),
        type: this.errorType,
        param: this.errorParam,
        code: this.errorCode,
      },
    };
  }
}

function serviceError(status, message, type, code) {
  return new ServiceError(status, message, { type, code });
}

/** Messages that indicate Qoder rejected our upstream credential. */
function isQoderAuthRejection(message) {
  return /login expired/i.test(message)
    || /credential is missing (userId|accessToken)/i.test(message)
    || (/qoder/i.test(message) && /\b(401|403)\b|unauthorized/i.test(message));
}

/**
 * Map any thrown value onto the error contract:
 *   QoderBillingError            → 429 insufficient_quota
 *   recognizable auth rejection  → 502 qoder_auth_error
 *   upstream/network failure     → 502 qoder_upstream_error
 *   anything else                → 500 internal_error
 */
export function toServiceError(error) {
  if (error instanceof ServiceError) return error;

  const message = String(error?.message || error || "unexpected error");
  const name = error?.name || "";

  if (name === "QoderBillingError" || /billing block|quota exhausted|pricingurl/i.test(message)) {
    return serviceError(
      429,
      `Qoder quota exhausted or throttled: ${message.slice(0, 300)}`,
      "rate_limit_error",
      "insufficient_quota",
    );
  }
  if (isQoderAuthRejection(message)) {
    return serviceError(
      502,
      `Qoder upstream rejected the configured credential: ${message.slice(0, 300)}`,
      "upstream_error",
      "qoder_auth_error",
    );
  }
  if (name === "AbortError" || error?.code === "ABORT_ERR") {
    // Caller disconnects surface as aborts — treat as upstream failure.
    return serviceError(502, "Upstream request aborted", "upstream_error", "qoder_upstream_error");
  }
  if (/^qoder\b/i.test(message) || /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|HTTP \d{3}/i.test(message)) {
    return serviceError(
      502,
      `Qoder upstream failure: ${message.slice(0, 300)}`,
      "upstream_error",
      "qoder_upstream_error",
    );
  }
  return serviceError(500, "Internal server error", "server_error", "internal_error");
}
