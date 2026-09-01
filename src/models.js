/**
 * Qoder model catalog fetcher — extracted from 9Router's
 * open-sse/services/qoderModels.js.
 *
 * Calls /algo/api/v2/model/list (COSY-signed) on the inference host to get
 * the live catalog for an authenticated Qoder account, then caches the
 * per-model `model_config` blocks by key. Chat requests later look up the
 * exact server-published metadata for the model they want — Qoder's chat
 * endpoint silently downgrades to a different model when the wrong
 * model_config is sent.
 *
 * Host split: job-token (jt-...) traffic must hit api2.qoder.sh — api3
 * rejects jt- with "Login expired" (403). Device tokens (dt-...) stay on
 * api3.
 */

import { createHash } from "crypto";

import { buildCosyHeaders } from "./cosy.js";
import { resolveQoderCredentials, isQoderPat, peekCachedPatUserId } from "./pat.js";
import { fetchWithTimeout } from "./http.js";
import {
  QODER_MODEL_LIST_URL,
  QODER_CHAT_BASE_ALT,
  QODER_USERINFO_URL,
} from "./constants.js";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h, same as the 9Router catalog cache

/** @type {Map<string, { expiresAt: number, models: any[], rawConfigs: Map<string, object>, fetched: boolean }>} */
const catalogCache = new Map();

/**
 * In-flight fetch promises keyed by cacheKey. Concurrent first-time
 * callers all observe the same Promise so we fan-out exactly one upstream
 * request per credential per miss.
 */
const inflight = new Map();

/** Clear the model-catalog cache (mainly for tests). */
export function clearCatalogCache() {
  catalogCache.clear();
}

/** Stable hashed cache identity for a resolved Qoder account userId. */
function userIdKey(userId) {
  return createHash("sha256").update(`qoder:${userId}`).digest("hex");
}

/**
 * Stable cache key per resolved credential. PAT-backed list and chat paths
 * both resolve to the same userId, so they share one catalog/inflight entry;
 * separate login sessions for the same account share it too.
 */
function cacheKey(credentials) {
  const psd = credentials?.providerSpecificData || {};
  const seed = psd.userId || credentials?.refreshToken || credentials?.accessToken || "anonymous";
  return createHash("sha256").update(`qoder:${seed}`).digest("hex");
}

/**
 * Strip credential -> COSY creds for buildCosyHeaders.
 */
function cosyCredsFromConnection(credentials) {
  const psd = credentials?.providerSpecificData || {};
  return {
    userId: psd.userId,
    authToken: credentials.accessToken,
    name: credentials.displayName || "",
    email: credentials.email || "",
    machineId: psd.machineId || "",
  };
}

/**
 * Fetch the live model list for this credential. Returns:
 *   { models: [{ id, name, contextLength, isVL, isReasoning, ... }, ...],
 *     rawConfigs: Map<modelKey, modelConfigObject> }
 * or `null` on any error.
 */
export async function fetchQoderCatalogRaw(credentials, options = {}) {
  const creds = cosyCredsFromConnection(credentials);
  if (!creds.userId || !creds.authToken) return null;

  // Job-token traffic is rejected by api3 ("Login expired" 403) — the
  // official qodercli serves it from api2 instead.
  const modelListUrl = String(creds.authToken).startsWith("jt-")
    ? `${QODER_CHAT_BASE_ALT}/algo/api/v2/model/list`
    : QODER_MODEL_LIST_URL;

  const headers = {
    Accept: "application/json",
    "Accept-Encoding": "identity",
    ...buildCosyHeaders(Buffer.alloc(0), modelListUrl, creds),
  };

  const response = await fetchWithTimeout(
    modelListUrl,
    { method: "GET", headers, signal: options.signal },
    options.timeoutMs,
    options.fetchImpl,
  );

  if (!response.ok) return null;

  const body = await response.json().catch(() => null);
  if (!body || !Array.isArray(body.chat)) return null;

  const models = [];
  const rawConfigs = new Map();
  for (const entry of body.chat) {
    if (!entry || typeof entry !== "object") continue;
    const key = entry.key;
    if (!key) continue;

    // Always cache the config — chat needs model_config even for UI-hidden
    // models (enable:false). Upstream still accepts chat for these keys.
    rawConfigs.set(key, entry);
    if (entry.enable === false) continue;

    const display = entry.display_name || key;
    const ctx = Number(entry.max_input_tokens) || 131_072;
    models.push({
      id: key,
      name: `${display}`,
      contextLength: ctx,
      isVL: !!entry.is_vl,
      isReasoning: !!entry.is_reasoning,
      maxOutputTokens: Number(entry.max_output_tokens) || 0,
      description: entry.description || "",
    });
  }

  return { models, rawConfigs };
}

/**
 * Get the cached model_config block for a given model key, fetching the
 * catalog first if needed. Returns null when the catalog can't be fetched
 * (so callers can fall back to a static list).
 */
export async function getQoderModelConfig(credentials, modelKey, options = {}) {
  const cached = await resolveQoderModels(credentials, options);
  if (!cached) return null;
  const config = cached.rawConfigs.get(modelKey);
  if (!config) return null;
  // Defensive copy — chat code may mutate `key` to align with the alias path.
  return { ...config, key: modelKey };
}

/**
 * Resolve the live model catalog + raw configs for a credential. Caches
 * results for CACHE_TTL_MS so repeated requests don't re-fetch, and
 * deduplicates concurrent misses so parallel callers fan-out exactly
 * one upstream request per credential.
 */
export async function resolveQoderModels(credentials, options = {}) {
  let resolved;
  try {
    resolved = await resolveQoderCredentials(credentials, options);
  } catch (error) {
    options.log?.warn?.("QODER", `PAT exchange failed: ${error.message}`);
    return null;
  }
  if (!resolved?.accessToken || !(resolved.providerSpecificData || {}).userId) return null;

  // Always key the catalog by the resolved account identity. listModels(),
  // chat model-config lookup, and concurrent misses therefore converge on one
  // cache/inflight entry for a PAT-backed account.
  const key = cacheKey(resolved);
  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = catalogCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached;
    }
  }

  // Coalesce concurrent misses on the same credential into one upstream call.
  // forceRefresh callers still get their own fetch (they wanted fresh data).
  const existing = inflight.get(key);
  if (existing && !options.forceRefresh) {
    return existing;
  }

  const fetchPromise = (async () => {
    const fetched = await fetchQoderCatalogRaw(resolved, options);
    if (!fetched) return null;
    const entry = {
      expiresAt: Date.now() + CACHE_TTL_MS,
      models: fetched.models,
      rawConfigs: fetched.rawConfigs,
      fetched: true,
    };
    catalogCache.set(key, entry);
    return entry;
  })();

  inflight.set(key, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    // Clear only if this is still the in-flight entry — a forceRefresh
    // call that started later may have replaced it.
    if (inflight.get(key) === fetchPromise) {
      inflight.delete(key);
    }
  }
}

export function invalidateCatalog(credentials) {
  if (!credentials) return;

  const raw = credentials?.apiKey || credentials?.accessToken;
  if (isQoderPat(raw)) {
    // PAT clients keep their original credential, while catalog entries are
    // keyed by the resolved account userId. A successful PAT resolution is
    // necessarily cached before a catalog entry can be written, so this
    // synchronous lookup identifies the same entry without network I/O.
    const userId = peekCachedPatUserId(raw);
    if (userId) catalogCache.delete(userIdKey(userId));
    return;
  }

  catalogCache.delete(cacheKey(credentials));
}

// Re-exported for callers that need the userinfo URL (e.g. quota lookups).
export { QODER_USERINFO_URL };
