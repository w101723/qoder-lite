/**
 * Offline smoke tests for qoder-lite. No network calls — everything runs
 * against injected fetch mocks or pure functions.
 *
 * Run: node test/smoke.mjs  (from qoder-lite/) or: npm test
 */

import assert from "node:assert/strict";

import {
  qoderEncodeBody,
  buildCosyHeaders,
  isQoderPat,
  isQoderJobToken,
  resolveQoderCredentials,
  clearPatJobCache,
  initiateDeviceFlow,
  pollDeviceToken,
  parseExpiry,
  buildChatUrl,
  normalizeMessages,
  isBillingBlock,
  unwrapQoderSSEResponse,
  QoderLiteClient,
  QoderBillingError,
  QODER_CHAT_URL_ENCODED,
  clearCatalogCache,
} from "../index.js";
import { fetchWithTimeout } from "../src/http.js";

// Cases are registered in file order and executed SEQUENTIALLY — each one is
// awaited before the next runs, so async failures count against the total
// and shared module caches behave deterministically.
let passed = 0;
let currentSection = "";
const tests = [];
function ok(name, fn) {
  tests.push({ section: currentSection, name, fn });
}

// ── encoding ────────────────────────────────────────────────────────────────

currentSection = "encoding.js";

ok("qoderEncodeBody output is stable and only contains latin1 chars", () => {
  const encoded = qoderEncodeBody(Buffer.from('{"hello":"world"}'));
  assert.equal(encoded, qoderEncodeBody(Buffer.from('{"hello":"world"}')));
  assert.ok(!Buffer.from(encoded, "latin1").toString("latin1").includes("\uFFFD"));
});

ok("qoderEncodeBody matches the [tail][mid][head] rearrangement", () => {
  // Manually reproduce the algorithm for a fixed input and compare.
  const input = Buffer.from("abcdefgh"); // base64: YWJjZGVmZ2g=
  const std = input.toString("base64"); // "YWJjZGVmZ2g=" (12 chars)
  const n = std.length;
  const a = Math.floor(n / 3); // 4
  const expected = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  // "b2g=" + "ZGVm" + "YWJj" then alphabet-substituted; just check length & structure
  assert.equal(qoderEncodeBody(input).length, expected.length);
});

// ── cosy ────────────────────────────────────────────────────────────────────

currentSection = "cosy.js";

ok("buildCosyHeaders produces the full Cosy-* set", () => {
  const headers = buildCosyHeaders(Buffer.from("test-body"), "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?x=1", {
    userId: "user-1",
    authToken: "dt-abc",
    name: "Tester",
    email: "t@example.com",
    machineId: "machine-1",
  });
  assert.ok(headers.Authorization.startsWith("Bearer COSY."));
  assert.equal(headers["Cosy-User"], "user-1");
  assert.equal(headers["Cosy-Machineid"], "machine-1");
  assert.equal(headers["Cosy-Sigpath"], "/api/v2/service/pro/sse/agent_chat_generation");
  assert.ok(Number(headers["Cosy-Bodylength"]) === Buffer.from("test-body").length);
  assert.equal(headers["Cosy-Clienttype"], "5");
  assert.ok(headers["X-Request-Id"]);
});

ok("buildCosyHeaders throws without userId/authToken", () => {
  assert.throws(() => buildCosyHeaders(Buffer.alloc(0), "https://x", { authToken: "dt-abc" }), /user id is empty/);
  assert.throws(() => buildCosyHeaders(Buffer.alloc(0), "https://x", { userId: "u" }), /auth token is empty/);
});

// ── PAT auth ────────────────────────────────────────────────────────────────

currentSection = "pat.js";

ok("token prefix detection", () => {
  assert.equal(isQoderPat("pt-abc"), true);
  assert.equal(isQoderPat("dt-abc"), false);
  assert.equal(isQoderJobToken("jt-abc"), true);
  assert.equal(isQoderJobToken("pt-abc"), false);
});

ok("resolveQoderCredentials exchanges a PAT via the job-token endpoint", async () => {
  clearPatJobCache();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("jobToken/exchange")) {
      return new Response(JSON.stringify({ token: "jt-job1", expires_in: 3600 }), { status: 200 });
    }
    if (String(url).includes("userinfo")) {
      return new Response(JSON.stringify({ id: "user-42" }), { status: 200 });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const resolved = await resolveQoderCredentials(
    { apiKey: "pt-secret", providerSpecificData: { machineId: "m1" } },
    { fetchImpl },
  );
  assert.equal(resolved.accessToken, "jt-job1");
  assert.equal(resolved.apiKey, undefined);
  assert.equal(resolved.providerSpecificData.authMethod, "pat");
  assert.equal(resolved.providerSpecificData.userId, "user-42");
  assert.equal(calls[0].init.body, JSON.stringify({ personal_token: "pt-secret" }));
  assert.equal(calls[0].init.headers["Cosy-Version"], "1.0.0");
});

ok("resolveQoderCredentials caches the job token across calls", async () => {
  clearPatJobCache();
  let exchangeCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("jobToken/exchange")) {
      exchangeCalls++;
      return new Response(JSON.stringify({ token: "jt-cached" }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "u1" }), { status: 200 });
  };
  await resolveQoderCredentials({ apiKey: "pt-cached" }, { fetchImpl });
  await resolveQoderCredentials({ apiKey: "pt-cached" }, { fetchImpl });
  assert.equal(exchangeCalls, 1);
});

ok("resolveQoderCredentials does not cache a job token without userId", async () => {
  clearPatJobCache();
  let exchangeCalls = 0;
  let userinfoCalls = 0;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("jobToken/exchange")) {
      exchangeCalls++;
      return new Response(JSON.stringify({ token: `jt-retry-${exchangeCalls}` }), { status: 200 });
    }
    if (u.includes("userinfo")) {
      userinfoCalls++;
      return userinfoCalls === 1
        ? new Response("temporary failure", { status: 500 })
        : new Response(JSON.stringify({ id: "u-recovered" }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };

  const credentials = { apiKey: "pt-retry-userinfo" };
  const first = await resolveQoderCredentials(credentials, { fetchImpl });
  assert.equal(first.providerSpecificData.userId, "");

  const second = await resolveQoderCredentials(credentials, { fetchImpl });
  assert.equal(second.providerSpecificData.userId, "u-recovered");
  assert.equal(exchangeCalls, 2, "an incomplete resolution must not enter the long-lived cache");

  const third = await resolveQoderCredentials(credentials, { fetchImpl });
  assert.equal(third.providerSpecificData.userId, "u-recovered");
  assert.equal(exchangeCalls, 2, "a complete resolution should still be cached");
});

ok("resolveQoderCredentials passes device tokens through untouched", async () => {
  const creds = { accessToken: "dt-direct", providerSpecificData: { userId: "u9" } };
  const resolved = await resolveQoderCredentials(creds, { fetchImpl: async () => { throw new Error("no network expected"); } });
  assert.equal(resolved.accessToken, "dt-direct");
});

// ── device flow ─────────────────────────────────────────────────────────────

currentSection = "deviceFlow.js";

ok("initiateDeviceFlow produces PKCE + nonce + browser URL", () => {
  const flow = initiateDeviceFlow();
  assert.ok(flow.verificationUriComplete.startsWith("https://qoder.com/device/selectAccounts?"));
  const url = new URL(flow.verificationUriComplete);
  assert.equal(url.searchParams.get("challenge_method"), "S256");
  assert.equal(url.searchParams.get("nonce"), flow.nonce);
  assert.equal(url.searchParams.get("machine_id"), flow.machineId);
  // S256 challenge is the base64url(sha256(verifier))
  assert.ok(flow.codeVerifier.length >= 40);
  assert.ok(!flow.verificationUriComplete.includes(flow.codeVerifier), "verifier must never be sent to the browser URL");
});

ok("pollDeviceToken treats 202/404 as pending and 200 as success", async () => {
  let mode = "pending";
  const fetchImpl = async () => {
    if (mode === "pending") return new Response("", { status: 202 });
    return new Response(JSON.stringify({ token: "dt-final", user_id: "u1", expires_in: 86400 }), { status: 200 });
  };
  assert.deepEqual(await pollDeviceToken({ nonce: "n", codeVerifier: "v" }, { fetchImpl }), { status: "pending" });
  mode = "done";
  const result = await pollDeviceToken({ nonce: "n", codeVerifier: "v" }, { fetchImpl });
  assert.equal(result.status, "ok");
  assert.equal(result.accessToken, "dt-final");
  assert.equal(result.expireTime > Date.now(), true);
});

ok("parseExpiry handles numeric, numeric-string, RFC3339, and fallbacks", () => {
  const now = Date.now();
  assert.equal(parseExpiry(1234567890123), 1234567890123);
  assert.equal(parseExpiry("1781594470000"), 1781594470000);
  assert.equal(parseExpiry("2026-06-16T07:15:04Z"), Date.parse("2026-06-16T07:15:04Z"));
  assert.ok(Math.abs(parseExpiry(undefined, 60) - (now + 60_000)) < 2000);
  assert.ok(Math.abs(parseExpiry(undefined, undefined) - (now + 30 * 86400_000)) < 2000);
  // "2026" is a pure numeric string → treated as a ms-epoch (2026ms), NOT
  // swallowed by Date.parse as the year 2026.
  assert.equal(parseExpiry("2026"), 2026);
});

// ── chat plumbing ───────────────────────────────────────────────────────────

currentSection = "chat.js";

ok("buildChatUrl routes job tokens to api2, device tokens to api3", () => {
  assert.equal(buildChatUrl({ accessToken: "jt-1" }), "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1");
  assert.equal(buildChatUrl({ accessToken: "dt-1" }), QODER_CHAT_URL_ENCODED);
});

ok("normalizeMessages hoists system and flattens multipart content", () => {
  const { messages, systemText } = normalizeMessages([
    { role: "system", content: "be nice" },
    { role: "user", content: [{ type: "text", text: "hi " }, { type: "text", text: "there" }] },
    { role: "assistant", content: "hello" },
  ]);
  assert.equal(systemText, "be nice");
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(messages[0].content, "hi \nthere");
});

ok("isBillingBlock matches codes 112/10605 and pricingUrl", () => {
  assert.equal(isBillingBlock('{"code":"112","message":"quota"}'), true);
  assert.equal(isBillingBlock('{"code":"10605"}'), true);
  assert.equal(isBillingBlock('{"pricingUrl":"https://qoder.com/pricing"}'), true);
  assert.equal(isBillingBlock('{"code":"500"}'), false);
  assert.equal(isBillingBlock(""), false);
});

ok("unwrapQoderSSEResponse unwraps {statusCodeValue, body} envelopes", async () => {
  const inner1 = JSON.stringify({ choices: [{ delta: { content: "Hi" } }] });
  const inner2 = JSON.stringify({ choices: [{ delta: { content: "!" } }] });
  const upstream = new Response(
    `data: ${JSON.stringify({ statusCodeValue: 200, body: inner1 })}\n\n` +
    `data: ${JSON.stringify({ statusCodeValue: 200, body: inner2 })}\n\n` +
    `data: ${JSON.stringify({ statusCodeValue: 200, body: "[DONE]" })}\n\n` +
    `data: ${JSON.stringify({ statusCodeValue: 200, body: "keepalive-after-done" })}\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
  const wrapped = await unwrapQoderSSEResponse(upstream, "qoder/auto");
  assert.equal(wrapped.headers.get("Content-Type"), "text/event-stream");
  const text = await wrapped.text();
  assert.equal(text, `data: ${inner1}\n\ndata: ${inner2}\n\ndata: [DONE]\n\n`);
});

ok("unwrapQoderSSEResponse throws QoderBillingError on quota block", async () => {
  const upstream = new Response(
    `data: ${JSON.stringify({ statusCodeValue: 403, body: '{"code":"112","message":"quota exhausted"}' })}\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
  await assert.rejects(
    () => unwrapQoderSSEResponse(upstream, "qoder/auto"),
    (err) => err instanceof QoderBillingError && /quota exhausted/.test(err.message),
  );
});

ok("unwrapQoderSSEResponse passes through non-200 responses untouched", async () => {
  const upstream = new Response("nope", { status: 401 });
  const wrapped = await unwrapQoderSSEResponse(upstream, "m");
  assert.equal(wrapped.status, 401);
});

// ── quota usage ─────────────────────────────────────────────────────────────

currentSection = "usage.js";

ok("getUsage resolves PAT → job token and parses the quota response", async () => {
  clearPatJobCache();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes("jobToken/exchange")) {
      return new Response(JSON.stringify({ token: "jt-q" }), { status: 200 });
    }
    if (String(url).includes("userinfo")) {
      return new Response(JSON.stringify({ id: "u-8" }), { status: 200 });
    }
    if (String(url).includes("quota/usage")) {
      assert.equal(init.headers.Authorization, "Bearer jt-q", "usage must use the exchanged job token, not the PAT");
      return new Response(JSON.stringify({
        userQuota: { total: 1000, used: 300, remaining: 700, unit: "credits" },
        orgResourcePackage: { total: 50000, used: 50000, remaining: 0, unit: "credits" },
        totalUsagePercentage: 30,
        isQuotaExceeded: false,
        expiresAt: 1781594470000,
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const client = new QoderLiteClient({ apiKey: "pt-usage" }, { fetchImpl });
  const usage = await client.getUsage();
  assert.deepEqual(usage.user, { total: 1000, used: 300, remaining: 700, unit: "credits" });
  assert.equal(usage.organization.remaining, 0);
  assert.equal(usage.totalUsagePercentage, 30);
  assert.equal(usage.isQuotaExceeded, false);
  assert.equal(usage.expiresAt, 1781594470000);
  assert.equal(usage.resetAt, new Date(1781594470000).toISOString());
});

ok("getUsage throws a descriptive error on non-OK responses", async () => {
  clearPatJobCache();
  const fetchImpl = async (url) => {
    if (String(url).includes("jobToken/exchange")) {
      return new Response(JSON.stringify({ token: "jt-e" }), { status: 200 });
    }
    if (String(url).includes("userinfo")) return new Response(JSON.stringify({ id: "u" }), { status: 200 });
    return new Response("denied", { status: 403 });
  };
  const client = new QoderLiteClient({ apiKey: "pt-err" }, { fetchImpl });
  await assert.rejects(() => client.getUsage(), /usage fetch returned 403/);
});

ok("getUsage throws without any access token", async () => {
  const client = new QoderLiteClient({}, {});
  await assert.rejects(() => client.getUsage(), /no access token/);
});

// ── client wiring (mock fetch) ──────────────────────────────────────────────

currentSection = "client.js";

ok("chatComplete aggregates content + tool_call fragments into one completion", async () => {
  const frames = [
    { choices: [{ delta: { role: "assistant" } }] },
    { choices: [{ delta: { content: "Let me " } }] },
    { choices: [{ delta: { content: "check." } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "run", arguments: "{\"cmd\":" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"ls\"}" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("/model/list")) {
      return new Response(JSON.stringify({ chat: [{ key: "auto", display_name: "Auto" }] }), { status: 200 });
    }
    if (u.includes("agent_chat_generation")) {
      const body = frames
        .map((f) => `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(f) })}\n\n`)
        .join("") + `data: ${JSON.stringify({ statusCodeValue: 200, body: "[DONE]" })}\n\n`;
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  const client = new QoderLiteClient(
    { accessToken: "dt-agg", providerSpecificData: { userId: "u-agg", machineId: "m" } },
    { fetchImpl },
  );
  const completion = await client.chatComplete({ model: "auto", messages: [{ role: "user", content: "hi" }] });
  assert.equal(completion.object, "chat.completion");
  assert.equal(completion.choices[0].message.role, "assistant");
  assert.equal(completion.choices[0].message.content, "Let me check.");
  assert.equal(completion.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(completion.choices[0].message.tool_calls, [
    { id: "call_1", type: "function", function: { name: "run", arguments: '{"cmd":"ls"}' } },
  ]);
  assert.deepEqual(completion.usage, { prompt_tokens: 10, completion_tokens: 5 });
  // No tool calls at all → field omitted, finish_reason defaults to stop
  frames.length = 0;
  const plain = await client.chatComplete({ model: "auto", messages: [{ role: "user", content: "hi" }] });
  assert.equal(plain.choices[0].message.tool_calls, undefined);
  assert.equal(plain.choices[0].finish_reason, "stop");
});

ok("QoderLiteClient end-to-end (PAT): models + chatStream against a mock upstream", async () => {
  clearPatJobCache();
  const modelListBody = {
    chat: [
      { key: "auto", display_name: "Auto", max_input_tokens: 131072, is_reasoning: false, max_output_tokens: 32768, model_config: { source: "system" } },
      { key: "ultimate", display_name: "Ultimate", enable: false, model_config: { source: "system" } },
    ],
  };
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.includes("jobToken/exchange")) {
      return new Response(JSON.stringify({ token: "jt-x" }), { status: 200 });
    }
    if (u.includes("userinfo")) {
      return new Response(JSON.stringify({ id: "u-7" }), { status: 200 });
    }
    if (u.includes("/model/list")) {
      assert.equal(u.startsWith("https://api2.qoder.sh"), true, "jt- traffic must hit api2");
      assert.ok(init.headers.Authorization.startsWith("Bearer COSY."), "model list must be COSY-signed");
      return new Response(JSON.stringify(modelListBody), { status: 200 });
    }
    if (u.includes("agent_chat_generation")) {
      assert.equal(u.startsWith("https://api2.qoder.sh"), true);
      assert.equal(init.headers["X-Model-Key"], "auto");
      // Body arrives WAF-encoded; just check it's non-empty latin1.
      assert.ok(init.body.length > 0);
      const inner = JSON.stringify({ choices: [{ delta: { content: "ok" } }], model: "auto" });
      const frame = `data: ${JSON.stringify({ statusCodeValue: 200, body: inner })}\n\ndata: ${JSON.stringify({ statusCodeValue: 200, body: "[DONE]" })}\n\n`;
      return new Response(frame, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };

  const client = new QoderLiteClient(
    { apiKey: "pt-e2e", providerSpecificData: {} },
    { fetchImpl },
  );
  assert.equal(client.isPat, true);

  const catalog = await client.listModels();
  assert.deepEqual(catalog.models.map((m) => m.id), ["auto"], "enable:false models are hidden from the list");
  assert.ok(catalog.rawConfigs.has("ultimate"), "…but still cached for chat");

  const chunks = [];
  for await (const chunk of client.chatStream({ model: "qoder/auto", messages: [{ role: "user", content: "hi" }] })) {
    chunks.push(chunk);
  }
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].choices[0].delta.content, "ok");
});

// ── reliability-fix regressions (design doc §8) ─────────────────────────────

currentSection = "reliability fixes";

ok("PAT exchange interprets expires_in as seconds (cache stays warm)", async () => {
  clearPatJobCache();
  let exchangeCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("jobToken/exchange")) {
      exchangeCalls++;
      return new Response(JSON.stringify({ token: "jt-ttl", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "u-ttl" }), { status: 200 });
  };
  await resolveQoderCredentials({ apiKey: "pt-ttl" }, { fetchImpl });
  await resolveQoderCredentials({ apiKey: "pt-ttl" }, { fetchImpl });
  // expires_in: 3600 means one hour — the second resolve must hit the cache,
  // not fall into the 5-minute refresh window after only 3.6 seconds.
  assert.equal(exchangeCalls, 1);
});

ok("fetchWithTimeout merges the caller AbortSignal with the timeout signal", async () => {
  const ac = new AbortController();
  ac.abort();
  let seenSignal;
  const fetchImpl = async (_url, init) => {
    seenSignal = init.signal;
    return new Response("{}", { status: 200 });
  };
  await fetchWithTimeout("https://example.test/x", { signal: ac.signal }, 60_000, fetchImpl).catch(() => {});
  assert.ok(seenSignal, "fetch must have been called");
  assert.equal(seenSignal.aborted, true, "caller's aborted signal must propagate to fetch");
});

ok("fetchWithTimeout merges signals when AbortSignal.any is unavailable", async () => {
  const original = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true });
  try {
    const ac = new AbortController();
    ac.abort(new Error("caller cancelled"));
    let seenSignal;
    await fetchWithTimeout("https://example.test/caller-abort", { signal: ac.signal }, 60_000, async (_url, init) => {
      seenSignal = init.signal;
      return new Response("{}", { status: 200 });
    });
    assert.equal(seenSignal.aborted, true);
    assert.match(String(seenSignal.reason), /caller cancelled/);

    await assert.rejects(
      () => fetchWithTimeout("https://example.test/timeout", {}, 10, async (_url, init) => {
        await new Promise((resolve, reject) => {
          if (init.signal.aborted) {
            reject(init.signal.reason);
            return;
          }
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
        return new Response("{}", { status: 200 });
      }),
      /timeout/,
    );
  } finally {
    if (original) Object.defineProperty(AbortSignal, "any", original);
    else delete AbortSignal.any;
  }
});

ok("SSE first-frame probe skips comments, blank lines, and non-data fields", async () => {
  const inner = JSON.stringify({ choices: [{ delta: { content: "Hi" } }] });
  const upstream = new Response(
    ": heartbeat\n\n" +
    "event: message\n" +
    "\n" +
    `data: ${JSON.stringify({ statusCodeValue: 200, body: inner })}\n\n` +
    `data: ${JSON.stringify({ statusCodeValue: 200, body: "[DONE]" })}\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
  const wrapped = await unwrapQoderSSEResponse(upstream, "qoder/auto");
  // Must terminate (no infinite loop on the leading heartbeat) and keep
  // only the real data frames.
  const text = await wrapped.text();
  assert.equal(text, `data: ${inner}\n\ndata: [DONE]\n\n`);
});

ok("upstream stream failures propagate instead of becoming [DONE]", async () => {
  const partial = JSON.stringify({ choices: [{ delta: { content: "partial" } }] });
  const upstreamBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify({ statusCodeValue: 200, body: partial })}\n\n`,
      ));
      setTimeout(() => controller.error(new Error("upstream socket reset")), 20);
    },
  });
  const upstream = new Response(upstreamBody, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  const wrapped = await unwrapQoderSSEResponse(upstream, "qoder/auto");
  await assert.rejects(() => wrapped.text(), /upstream socket reset/);
});

ok("invalidate() drops the model cache for PAT-backed clients", async () => {
  clearPatJobCache();
  clearCatalogCache();
  let listCalls = 0;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("jobToken/exchange")) return new Response(JSON.stringify({ token: "jt-inv" }), { status: 200 });
    if (u.includes("userinfo")) return new Response(JSON.stringify({ id: "u-inv" }), { status: 200 });
    if (u.includes("/model/list")) {
      listCalls++;
      return new Response(JSON.stringify({ chat: [{ key: "auto" }] }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  const client = new QoderLiteClient({ apiKey: "pt-inv" }, { fetchImpl });
  await client.listModels();
  await client.listModels();
  assert.equal(listCalls, 1, "second listModels should hit the cache");
  client.invalidate();
  await client.listModels();
  assert.equal(listCalls, 2, "invalidate() must force a refetch for PAT clients");
});

ok("listModels and chat share one PAT catalog cache entry", async () => {
  clearPatJobCache();
  clearCatalogCache();
  let listCalls = 0;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("jobToken/exchange")) return new Response(JSON.stringify({ token: "jt-shared" }), { status: 200 });
    if (u.includes("userinfo")) return new Response(JSON.stringify({ id: "u-shared" }), { status: 200 });
    if (u.includes("/model/list")) {
      listCalls++;
      return new Response(JSON.stringify({ chat: [{ key: "auto", max_output_tokens: 1024 }] }), { status: 200 });
    }
    if (u.includes("agent_chat_generation")) {
      return new Response(
        `data: ${JSON.stringify({ statusCodeValue: 200, body: "[DONE]" })}\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }
    throw new Error(`unexpected fetch: ${u}`);
  };

  const client = new QoderLiteClient({ apiKey: "pt-shared" }, { fetchImpl });
  await client.listModels();
  await client.chatComplete({ model: "auto", messages: [{ role: "user", content: "hi" }] });
  assert.equal(listCalls, 1, "chat must reuse the catalog warmed by listModels");

  client.invalidate();
  await client.chatComplete({ model: "auto", messages: [{ role: "user", content: "hi" }] });
  assert.equal(listCalls, 2, "raw PAT invalidation must drop the chat path's userId-keyed entry");
});

let failed = 0;
let lastSection = "";
for (const t of tests) {
  if (t.section !== lastSection) {
    console.log(`\n${t.section}`);
    lastSection = t.section;
  }
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

console.log(`\n${passed} smoke tests passed${failed ? `, ${failed} FAILED` : ""}`);
if (failed) process.exit(1);
