/**
 * Qoder device-flow OAuth — extracted from 9Router's
 * src/lib/oauth/services/qoder.js.
 *
 * Flow:
 *   1. Generate PKCE pair + nonce + machine_id locally.
 *   2. Open https://qoder.com/device/selectAccounts?challenge=...&nonce=...
 *      in the user's browser.
 *   3. Poll openapi.qoder.sh/api/v1/deviceToken/poll until the user
 *      authorizes and the upstream returns a `dt-...` access token.
 *
 * Tokens live ~30 days; refresh is a no-op (the upstream refresh endpoint
 * returns 403 for this flow). Users re-run login when expired.
 */

import crypto from "crypto";

import {
  QODER_DEVICE_TOKEN_URL,
  QODER_LOGIN_URL,
  QODER_USERINFO_URL,
} from "./constants.js";
import { fetchWithTimeout } from "./http.js";

export const DEVICE_FLOW_POLL_INTERVAL_MS = 2_000;
export const DEVICE_FLOW_EXPIRES_IN_MS = 5 * 60 * 1000;

function base64Url(buf) {
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Generate a PKCE verifier + S256 challenge pair.
 * Uses 32 random bytes (matches qodercli/Veria).
 */
export function generatePkcePair() {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Initiate the device flow. Returns the URL to open in a browser plus the
 * verifier/nonce/machineId we'll need to poll and to sign future requests.
 */
export function initiateDeviceFlow() {
  const { verifier, challenge } = generatePkcePair();
  const nonce = crypto.randomUUID();
  const machineId = crypto.randomUUID();

  const params = new URLSearchParams({
    challenge,
    challenge_method: "S256",
    machine_id: machineId,
    nonce,
  });

  return {
    verificationUriComplete: `${QODER_LOGIN_URL}?${params.toString()}`,
    codeVerifier: verifier,
    nonce,
    machineId,
  };
}

/**
 * Single poll attempt. Returns one of:
 *   { status: "pending" }       — keep polling
 *   { status: "ok", token, ... } — user authorized, tokens captured
 *   throws Error                 — terminal failure
 *
 * Upstream returns 202/404 while waiting; 200 with a JSON body when done.
 */
export async function pollDeviceToken({ nonce, codeVerifier }, options = {}) {
  if (!nonce || !codeVerifier) {
    throw new Error("pollDeviceToken: missing nonce or code verifier");
  }
  const url = `${QODER_DEVICE_TOKEN_URL}?nonce=${encodeURIComponent(nonce)}&verifier=${encodeURIComponent(codeVerifier)}&challenge_method=S256`;

  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Go-http-client/2.0",
      },
    },
    options.timeoutMs,
    options.fetchImpl,
  );

  // Pending — server has registered the device code but the user hasn't
  // finished the browser flow yet. Both 202 and 404 mean "keep polling".
  if (response.status === 202 || response.status === 404) {
    return { status: "pending" };
  }

  const text = await response.text();

  if (!response.ok) {
    let message = `Qoder device token poll failed: HTTP ${response.status}`;
    try {
      const body = JSON.parse(text);
      if (body.message) message = `Qoder device token poll failed: ${body.message}`;
    } catch {}
    throw new Error(message);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw new Error(`Qoder device token poll: invalid JSON response (${err.message})`);
  }

  // Defensive: 200 + empty token means the upstream changed shape.
  if (!body.token) {
    throw new Error("Qoder device token poll returned 200 but no token");
  }

  return {
    status: "ok",
    accessToken: body.token,
    refreshToken: body.refresh_token || "",
    userId: body.user_id || "",
    expireTime: parseExpiry(body.expires_at, body.expires_in),
    rawResponse: body,
  };
}

/**
 * Full device login: poll every 2s for up to 5 minutes until the user
 * authorizes in the browser. Resolve with the token result, or reject on
 * terminal poll failure / timeout.
 */
export async function loginWithDeviceFlow(flow, options = {}) {
  const deadline = Date.now() + (options.totalTimeoutMs ?? DEVICE_FLOW_EXPIRES_IN_MS);
  const intervalMs = options.intervalMs ?? DEVICE_FLOW_POLL_INTERVAL_MS;
  while (Date.now() < deadline) {
    const result = await pollDeviceToken({ nonce: flow.nonce, codeVerifier: flow.codeVerifier }, options);
    if (result.status === "ok") return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Qoder device flow: authorization timed out");
}

/**
 * Fetch profile info for a freshly-issued token. Best-effort — failures
 * shouldn't block login; returning empty strings is fine.
 */
export async function fetchUserInfo(accessToken, options = {}) {
  try {
    const response = await fetchWithTimeout(
      QODER_USERINFO_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "User-Agent": "Go-http-client/2.0",
        },
      },
      options.timeoutMs,
      options.fetchImpl,
    );
    if (!response.ok) return { name: "", email: "" };
    const body = await response.json();
    return {
      name: (body.name || body.username || "").trim(),
      email: (body.email || "").trim(),
      organizationId: (body.organization_id || "").trim(),
    };
  } catch {
    return { name: "", email: "" };
  }
}

/**
 * Convert the upstream's expiry hint into a Unix-millisecond timestamp.
 * Accepts:
 *   - numeric (ms-epoch): returned as-is
 *   - numeric string of ms-epoch: e.g. "1781594470000"
 *   - RFC3339 string: e.g. "2026-06-16T07:15:04Z"
 *   - seconds-from-now via expiresInSeconds (>= 0)
 * Falls back to "now + 30 days" when both are missing.
 *
 * Order matters: try numeric (string or number) before Date.parse, since
 * Date.parse accepts short numeric strings like "2026" as years and would
 * otherwise return a misleading year-2026 timestamp instead of falling
 * through to the integer branch.
 */
export function parseExpiry(expiresAt, expiresInSeconds) {
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) {
    return expiresAt;
  }
  const trimmed = typeof expiresAt === "string" ? expiresAt.trim() : "";
  if (trimmed) {
    // Pure numeric string → ms-epoch (don't let Date.parse swallow short
    // numerics as years).
    if (/^\d+$/.test(trimmed)) {
      const ms = Number.parseInt(trimmed, 10);
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }
  // expiresInSeconds === 0 means "already expired"; honor that by returning
  // the current time rather than fabricating a 30-day default.
  if (typeof expiresInSeconds === "number" && Number.isFinite(expiresInSeconds) && expiresInSeconds >= 0) {
    return Date.now() + expiresInSeconds * 1000;
  }
  return Date.now() + 30 * 24 * 60 * 60 * 1000;
}
