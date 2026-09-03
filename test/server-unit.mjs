/**
 * Offline unit tests for the qoder-lite HTTP service — pure functions only:
 * config parsing/validation, Bearer auth, error serialization, OpenAI
 * conversions, redaction, and chat-body validation.
 *
 * Run: node test/server-unit.mjs
 */

import assert from "node:assert/strict";

import { loadServerConfig, ConfigError } from "../src/server/config.js";
import { extractBearerToken, isApiKeyValid } from "../src/server/auth.js";
import { ServiceError, toServiceError, redactSecrets } from "../src/server/errors.js";
import {
  toOpenAiModelList,
  toBillingSubscription,
  toBillingUsage,
  toCreditGrants,
} from "../src/server/openai.js";
import { validateChatBody } from "../src/server/app.js";
import { MAX_BODY_BYTES } from "../src/server/body.js";

let passed = 0;
let failed = 0;
const tests = [];
function ok(name, fn) {
  tests.push({ name, fn });
}

// ── config ──────────────────────────────────────────────────────────────────

ok("config applies documented defaults", () => {
  const config = loadServerConfig({ QODER_PAT: "pt-abc", API_KEY: "k" });
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 3000);
  assert.equal(config.qoderPat, "pt-abc");
  assert.equal(config.apiKey, "k");
});

ok("config rejects missing QODER_PAT, API_KEY, and bad PORT together", () => {
  assert.throws(
    () => loadServerConfig({ PORT: "nope" }),
    (err) => err instanceof ConfigError
      && err.problems.length === 3
      && err.problems.some((p) => p.includes("QODER_PAT"))
      && err.problems.some((p) => p.includes("API_KEY"))
      && err.problems.some((p) => p.includes("PORT")),
  );
});

ok("config rejects a PAT without the pt- prefix", () => {
  assert.throws(
    () => loadServerConfig({ QODER_PAT: "jt-oops", API_KEY: "k" }),
    (err) => err instanceof ConfigError && /pt- prefix/.test(err.message),
  );
});

ok("config rejects out-of-range and non-integer ports", () => {
  for (const port of ["0", "65536", "3.5", "-1"]) {
    assert.throws(() => loadServerConfig({ QODER_PAT: "pt-a", API_KEY: "k", PORT: port }), ConfigError);
  }
  // boundary values are fine
  assert.equal(loadServerConfig({ QODER_PAT: "pt-a", API_KEY: "k", PORT: "1" }).port, 1);
  assert.equal(loadServerConfig({ QODER_PAT: "pt-a", API_KEY: "k", PORT: "65535" }).port, 65535);
});

// ── auth ────────────────────────────────────────────────────────────────────

ok("extractBearerToken parses the Authorization header", () => {
  assert.equal(extractBearerToken({ headers: { authorization: "Bearer abc" } }), "abc");
  assert.equal(extractBearerToken({ headers: { authorization: "bearer abc" } }), "abc");
  assert.equal(extractBearerToken({ headers: { authorization: "Basic abc" } }), "");
  assert.equal(extractBearerToken({ headers: {} }), "");
  assert.equal(extractBearerToken({ headers: { authorization: "Bearer   " } }), "");
});

ok("isApiKeyValid compares keys and rejects everything else", () => {
  assert.equal(isApiKeyValid("secret", "secret"), true);
  assert.equal(isApiKeyValid("secret", "other"), false);
  assert.equal(isApiKeyValid("", "secret"), false);
  assert.equal(isApiKeyValid("secret", ""), false);
  assert.equal(isApiKeyValid(undefined, "secret"), false);
  // different lengths must not throw (timingSafeEqual requires equal lengths)
  assert.equal(isApiKeyValid("a", "much-longer-key"), false);
});

// ── errors ──────────────────────────────────────────────────────────────────

ok("ServiceError serializes to the OpenAI error shape", () => {
  const error = new ServiceError(401, "Incorrect API key provided", {
    type: "authentication_error",
    code: "invalid_api_key",
  });
  assert.deepEqual(error.toJSON(), {
    error: { message: "Incorrect API key provided", type: "authentication_error", param: null, code: "invalid_api_key" },
  });
});

ok("toServiceError maps QoderBillingError to 429 insufficient_quota", () => {
  const billing = new Error('{"code":"112","message":"quota exhausted"}');
  billing.name = "QoderBillingError";
  const mapped = toServiceError(billing);
  assert.equal(mapped.status, 429);
  assert.equal(mapped.errorType, "rate_limit_error");
  assert.equal(mapped.errorCode, "insufficient_quota");
});

ok("toServiceError maps an exhausted 403 throttle to 429 qoder_throttled", () => {
  const throttle = new Error('qoder upstream returned 403: {"code":"10605","retryAfterSeconds":2}');
  throttle.name = "QoderUpstreamStatusError";
  throttle.isThrottle = true;
  const mapped = toServiceError(throttle);
  assert.equal(mapped.status, 429);
  assert.equal(mapped.errorType, "rate_limit_error");
  assert.equal(mapped.errorCode, "qoder_throttled");
});

ok("toServiceError maps an exhausted non-throttle 403 to 502", () => {
  const upstream = new Error('qoder upstream returned 403: {"code":"403","message":"denied"}');
  upstream.name = "QoderUpstreamStatusError";
  const mapped = toServiceError(upstream);
  assert.equal(mapped.status, 502);
  assert.equal(mapped.errorCode, "qoder_auth_error");
});

ok("toServiceError maps recognizable auth rejections to 502 qoder_auth_error", () => {
  for (const message of [
    "qoder PAT exchange failed: 401 ",
    "qoder usage fetch returned 403 denied",
    "qoder credential is missing userId; reconnect the account",
  ]) {
    const mapped = toServiceError(new Error(message));
    assert.equal(mapped.status, 502, message);
    assert.equal(mapped.errorCode, "qoder_auth_error", message);
  }
});

ok("toServiceError maps upstream failures to 502 qoder_upstream_error", () => {
  for (const error of [
    new Error("qoder chat failed: HTTP 502 bad gateway"),
    new Error("fetch failed"),
    new TypeError("fetch failed"),
    new Error("qoder: model_config for \"auto\" not yet known"),
  ]) {
    const mapped = toServiceError(error);
    assert.equal(mapped.status, 502);
    assert.equal(mapped.errorCode, "qoder_upstream_error");
  }
});

ok("toServiceError keeps unknown errors internal (500)", () => {
  const mapped = toServiceError(new Error("some unexpected bug"));
  assert.equal(mapped.status, 500);
  assert.equal(mapped.errorType, "server_error");
  assert.equal(mapped.errorCode, "internal_error");
});

ok("redactSecrets hides pt-/jt-/dt- tokens and Bearer values", () => {
  const redacted = redactSecrets("pat pt-abcdefgh1234 jt-xyz987 dt-qqq1 and Bearer sk-abc123");
  assert.ok(!redacted.includes("pt-abcdefgh1234"));
  assert.ok(!redacted.includes("jt-xyz987"));
  assert.ok(!redacted.includes("dt-qqq1"));
  assert.ok(!redacted.includes("sk-abc123"));
  assert.ok(redacted.includes("pt-[REDACTED]"));
  assert.ok(redacted.includes("Bearer [REDACTED]"));
});

// ── OpenAI conversions ──────────────────────────────────────────────────────

ok("toOpenAiModelList converts the catalog and exposes dmodel", () => {
  const list = toOpenAiModelList({
    models: [
      { id: "auto", dmodel: "DeepSeek-V4-Pro" },
      { id: "ultimate" },
    ],
  });
  assert.equal(list.object, "list");
  assert.deepEqual(list.data, [
    { id: "auto", object: "model", created: 0, owned_by: "qoder", dmodel: "DeepSeek-V4-Pro" },
    { id: "ultimate", object: "model", created: 0, owned_by: "qoder", dmodel: "" },
  ]);
  // empty catalog → empty list, not an error
  assert.deepEqual(toOpenAiModelList({ models: [] }).data, []);
});

ok("toBillingSubscription maps all three limits to usage.user.total", () => {
  const sub = toBillingSubscription({ user: { total: 1000, used: 300 } });
  assert.equal(sub.object, "billing_subscription");
  assert.equal(sub.has_payment_method, true);
  assert.equal(sub.soft_limit_usd, 1000);
  assert.equal(sub.hard_limit_usd, 1000);
  assert.equal(sub.system_hard_limit_usd, 1000);
  assert.equal(sub.access_until, 0);
});

ok("toBillingUsage returns the original used credits", () => {
  assert.deepEqual(toBillingUsage({ user: { used: 300 } }), { object: "list", total_usage: 300 });
  assert.equal(toBillingUsage({ user: { used: 0.5 } }).total_usage, 0.5);
  assert.equal(toBillingUsage({ user: { used: 1.005 } }).total_usage, 1.005);
  assert.equal(toBillingUsage({ user: {} }).total_usage, 0);
});

ok("toCreditGrants returns total minus used without scaling", () => {
  assert.deepEqual(
    toCreditGrants({ user: { total: 3000, used: 127 } }),
    { object: "credit_summary", total_available: 2873 },
  );
  assert.equal(toCreditGrants({ user: { total: 10.5, used: 1.25 } }).total_available, 9.25);
  assert.equal(toCreditGrants({ user: {} }).total_available, 0);
});

// ── chat validation ─────────────────────────────────────────────────────────

ok("validateChatBody flags missing model and messages", () => {
  assert.equal(validateChatBody({ model: "auto", messages: [] }), null);
  assert.equal(validateChatBody({ messages: [] }), "model");
  assert.equal(validateChatBody({ model: "", messages: [] }), "model");
  assert.equal(validateChatBody({ model: "auto" }), "messages");
  assert.equal(validateChatBody({ model: "auto", messages: "hi" }), "messages");
  assert.equal(validateChatBody(null), "body");
  assert.equal(validateChatBody([1, 2]), "body");
  assert.equal(validateChatBody("nope"), "body");
});

ok("body limit is 100 MiB", () => {
  assert.equal(MAX_BODY_BYTES, 100 * 1024 * 1024);
});

// ── runner ──────────────────────────────────────────────────────────────────

for (const t of tests) {
  try {
    await t.fn();
    passed++;
    console.log(`  ✓ ${t.name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${t.name}`);
    console.error(`    ${error?.stack || error}`);
  }
}

console.log(`\n${passed} server unit tests passed${failed ? `, ${failed} FAILED` : ""}`);
if (failed) process.exit(1);
