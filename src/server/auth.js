/**
 * Bearer-token extraction and constant-time API-key comparison.
 *
 * Both operands are hashed to equal-length buffers before the comparison so
 * timing leaks neither the key length nor its content. Missing and incorrect
 * keys are indistinguishable from the caller's point of view.
 */

import { createHash, timingSafeEqual } from "crypto";

/** Extract the Bearer token from a request; returns "" when absent/malformed. */
export function extractBearerToken(req) {
  const header = String(req.headers.authorization || "");
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice(7).trim();
}

/** Constant-time comparison of a presented key against the expected key. */
export function isApiKeyValid(provided, expected) {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
