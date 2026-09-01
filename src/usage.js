/**
 * Qoder quota usage — ported from 9Router's open-sse/services/usage/misc.js
 * (getQoderUsage).
 *
 * GET https://openapi.qoder.sh/api/v2/quota/usage with a Bearer token.
 * IMPORTANT: a PAT (pt-...) cannot hit this endpoint directly — exchange it
 * for a job token first (use QoderLiteClient.getUsage(), which resolves
 * credentials automatically, or resolveQoderCredentials() yourself).
 *
 * Response shape (upstream):
 *   {
 *     userQuota:          { total, used, remaining, unit },
 *     orgResourcePackage: { total, used, remaining, unit },
 *     totalUsagePercentage, isQuotaExceeded, expiresAt   // expiresAt: ms epoch reset time
 *   }
 */

import { resolveQoderCredentials } from "./pat.js";
import { fetchWithTimeout } from "./http.js";
import { QODER_QUOTA_USAGE_URL } from "./constants.js";

function quotaBlock(raw) {
  const r = raw || {};
  return {
    total: Number(r.total) || 0,
    used: Number(r.used) || 0,
    remaining: Number(r.remaining) || 0,
    unit: r.unit || "credits",
  };
}

/**
 * Fetch quota usage for a resolved (dt-/jt-) token.
 *
 * @param {string} accessToken  Device or job token — NOT a raw PAT.
 * @param {object} [options]    { fetchImpl?, timeoutMs?, signal? }
 * @returns {Promise<object>}   { user, organization, totalUsagePercentage,
 *                               isQuotaExceeded, expiresAt, resetAt }
 * @throws {Error} on non-OK responses or network failures.
 */
export async function getQoderUsage(accessToken, options = {}) {
  if (!accessToken) {
    throw new Error("qoder usage unavailable: no access token");
  }
  const response = await fetchWithTimeout(
    QODER_QUOTA_USAGE_URL,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: options.signal,
    },
    options.timeoutMs,
    options.fetchImpl,
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`qoder usage fetch returned ${response.status} ${text.slice(0, 200)}`);
  }
  const body = await response.json();
  if (!body || typeof body !== "object") {
    throw new Error("qoder usage response was not JSON");
  }

  // Qoder publishes a single absolute reset timestamp (`expiresAt` in ms);
  // surface it both raw and as ISO so callers can render "resets at".
  const expiresAtMs = Number.isFinite(Number(body.expiresAt)) && Number(body.expiresAt) > 0
    ? Number(body.expiresAt)
    : null;

  return {
    user: quotaBlock(body.userQuota),
    organization: quotaBlock(body.orgResourcePackage),
    totalUsagePercentage: Number(body.totalUsagePercentage) || 0,
    isQuotaExceeded: !!body.isQuotaExceeded,
    expiresAt: expiresAtMs,
    resetAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
  };
}

/**
 * Resolve credentials (PAT → job token when needed) and fetch usage in one
 * step. Mirrors 9Router's services/usage.js qoder entry.
 */
export async function resolveAndFetchUsage(credentials, options = {}) {
  const resolved = await resolveQoderCredentials(credentials, options).catch(() => null);
  return getQoderUsage(resolved?.accessToken || credentials?.accessToken, options);
}
