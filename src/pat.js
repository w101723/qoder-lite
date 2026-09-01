/**
 * Qoder PAT (Personal Access Token) authentication — extracted from
 * 9Router's open-sse/services/qoderModels.js.
 *
 * Core constraint: a PAT (pt-...) cannot sign COSY requests directly.
 * It must be exchanged for a short-lived job token (jt-...) via
 * openapi.qoder.sh/api/v1/jobToken/exchange (plain JSON POST, NOT
 * COSY-signed). The job token then signs COSY requests like a device
 * token would — but only against api2.qoder.sh (api3 rejects jt- with
 * "Login expired" 403).
 *
 * Job tokens live ~24h; we cache per-PAT and re-exchange once within
 * 5 minutes of expiry.
 */

import {
  QODER_JOB_TOKEN_EXCHANGE_URL,
  QODER_USERINFO_URL,
  QODER_IDE_VERSION,
  QODER_CLIENT_TYPE,
} from "./constants.js";
import { fetchWithTimeout } from "./http.js";

export const PAT_PREFIX = "pt-";
export const JOB_TOKEN_PREFIX = "jt-";
export const DEVICE_TOKEN_PREFIX = "dt-";

export function isQoderPat(token) {
  return typeof token === "string" && token.startsWith(PAT_PREFIX);
}

export function isQoderJobToken(token) {
  return typeof token === "string" && token.startsWith(JOB_TOKEN_PREFIX);
}

// PAT → job-token cache: a job token is short-lived (24h), so we keep it per
// PAT and re-exchange once it is within 5 minutes of expiry.
const PAT_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const PAT_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** @type {Map<string, { accessToken: string, userId: string, expiresAt: number }>} */
const patJobCache = new Map();

/** Clear the PAT→job-token cache (mainly for tests). */
export function clearPatJobCache() {
  patJobCache.clear();
}

/**
 * Return the userId from a successfully resolved PAT cache entry without
 * triggering network I/O. Used by synchronous cache invalidation paths.
 */
export function peekCachedPatUserId(pat) {
  return patJobCache.get(pat)?.userId || "";
}

/**
 * Exchange a Qoder PAT (pt-...) for a short-lived job token (jt-...).
 * This endpoint is plain JSON POST — NOT COSY-signed.
 */
export async function exchangeJobToken(pat, { fetchImpl, timeoutMs } = {}) {
  const res = await fetchWithTimeout(
    QODER_JOB_TOKEN_EXCHANGE_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "qodercli/1.0.0",
        "Cosy-Version": QODER_IDE_VERSION,
        "Cosy-ClientType": QODER_CLIENT_TYPE,
      },
      body: JSON.stringify({ personal_token: pat }),
    },
    timeoutMs,
    fetchImpl,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`qoder PAT exchange failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.token) throw new Error("qoder PAT exchange returned no job token");

  let expiresAt = Date.now() + PAT_DEFAULT_TTL_MS;
  if (data.expires_at) {
    const parsed = Date.parse(data.expires_at);
    if (!Number.isNaN(parsed)) expiresAt = parsed;
  } else if (typeof data.expires_in === "number" && data.expires_in > 0) {
    // expires_in is in SECONDS (OAuth convention) — convert to ms.
    expiresAt = Date.now() + data.expires_in * 1000;
  }
  return { jobToken: data.token, jobRefreshToken: data.refresh_token || "", expiresAt };
}

/**
 * Resolve the Qoder userId for a job token (needed for COSY signing).
 * Returns "" on any failure — callers fall back to a stored userId.
 */
export async function fetchUserIdForJobToken(jobToken, { fetchImpl, timeoutMs } = {}) {
  try {
    const res = await fetchWithTimeout(
      QODER_USERINFO_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${jobToken}`,
          Accept: "application/json",
          "User-Agent": "qodercli/1.0.0",
        },
      },
      timeoutMs,
      fetchImpl,
    );
    if (!res.ok) return "";
    const data = await res.json().catch(() => ({}));
    return data.id || data.userId || data.user_id || "";
  } catch {
    return "";
  }
}

/**
 * Resolve a PAT to a job-token credential, cached per-PAT.
 */
export async function resolvePatCredential(pat, options = {}) {
  const cached = patJobCache.get(pat);
  if (cached && cached.expiresAt - Date.now() > PAT_REFRESH_BUFFER_MS) return cached;

  const { jobToken, expiresAt } = await exchangeJobToken(pat, options);
  const userId = await fetchUserIdForJobToken(jobToken, options);
  const resolved = { accessToken: jobToken, userId, expiresAt };
  // A missing userId means userinfo failed or returned an incomplete body.
  // Return the result for this call (the caller may have a stored fallback),
  // but do not poison the long-lived cache — the next call should retry.
  if (userId) patJobCache.set(pat, resolved);
  return resolved;
}

/**
 * Resolve credentials to COSY-signable form:
 *   - PAT (pt-...) connections → exchanged to a job token (jt-...) + userId
 *   - device tokens (dt-...) / job tokens (jt-...) → passed through unchanged
 *
 * The input credential shape matches 9Router's connection records:
 *   { apiKey?, accessToken?, refreshToken?, email?, displayName?,
 *     providerSpecificData?: { userId?, machineId?, ... } }
 *
 * Accepts an options bag: { fetchImpl?, timeoutMs? } plus optional
 * `signal` / `log` for parity with the 9Router call sites.
 */
export async function resolveQoderCredentials(credentials, options = {}) {
  const raw = credentials?.apiKey || credentials?.accessToken;
  if (isQoderPat(raw)) {
    const resolved = await resolvePatCredential(raw, options);
    return {
      ...credentials,
      accessToken: resolved.accessToken,
      apiKey: undefined,
      providerSpecificData: {
        authMethod: "pat",
        ...(credentials?.providerSpecificData || {}),
        userId: resolved.userId || credentials?.providerSpecificData?.userId || "",
        machineId: credentials?.providerSpecificData?.machineId || "",
      },
    };
  }
  return credentials;
}
