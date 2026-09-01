/**
 * Offline integration tests for the qoder-lite HTTP service.
 *
 * Starts a real Node HTTP server on an ephemeral loopback port with an
 * injected fake Qoder client — no real Qoder connections, no network beyond
 * 127.0.0.1.
 *
 * Run: node test/server-integration.mjs
 */

import assert from "node:assert/strict";
import http from "node:http";

import { createRequestHandler } from "../src/server/app.js";

const API_KEY = "test-adapter-key-0123456789abcdef";
const USAGE = {
  user: { total: 1000, used: 300, remaining: 700, unit: "credits" },
  organization: { total: 50000, used: 50000, remaining: 0, unit: "credits" },
  totalUsagePercentage: 30,
  isQuotaExceeded: false,
  expiresAt: 1781594470000,
  resetAt: new Date(1781594470000).toISOString(),
};

const encoder = new TextEncoder();

function sseResponse(frames, { status = 200 } = {}) {
  return new Response(frames, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function chunk(delta, extra = {}) {
  return `data: ${JSON.stringify({ choices: [{ delta }], ...extra })}\n\n`;
}

/** Build a fake client whose methods can be overridden per scenario. */
function makeFakeClient(overrides = {}) {
  const state = { signals: [], chatCalls: 0, chatCompleteCalls: 0, listModelsCalls: 0, usageCalls: 0 };
  const client = {
    async listModels() {
      state.listModelsCalls++;
      return { models: [{ id: "auto" }, { id: "ultimate" }], rawConfigs: new Map() };
    },
    async chatComplete(body, options = {}) {
      state.chatCompleteCalls++;
      state.signals.push(options.signal);
      return {
        id: "chatcmpl-fake-1",
        object: "chat.completion",
        created: 1700000000,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      };
    },
    async chat(body, options = {}) {
      state.chatCalls++;
      state.signals.push(options.signal);
      return sseResponse(
        chunk({ role: "assistant" }) +
        chunk({ content: "Hi" }) +
        "data: [DONE]\n\n",
      );
    },
    async getUsage() {
      state.usageCalls++;
      return USAGE;
    },
    ...overrides,
  };
  return { client, state };
}

async function startServer(client) {
  const server = http.createServer(createRequestHandler({ client, apiKey: API_KEY }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

const jsonHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` };

let passed = 0;
let failed = 0;
const tests = [];
function ok(name, fn) {
  tests.push({ name, fn });
}

async function withServer(overrides, fn) {
  const fake = makeFakeClient(overrides);
  const { server, base } = await startServer(fake.client);
  try {
    return await fn(base, fake);
  } finally {
    server.close();
  }
}

// ── health & auth ───────────────────────────────────────────────────────────

ok("GET /health is unauthenticated and returns process health only", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });
});

ok("/v1/* without a key and with a wrong key return identical 401s", async () => {
  await withServer({}, async (base) => {
    const missing = await fetch(`${base}/v1/models`);
    const wrong = await fetch(`${base}/v1/models`, { headers: { Authorization: "Bearer wrong-key" } });
    assert.equal(missing.status, 401);
    assert.equal(wrong.status, 401);
    const missingBody = await missing.json();
    const wrongBody = await wrong.json();
    assert.deepEqual(missingBody, wrongBody);
    assert.deepEqual(missingBody, {
      error: { message: "Incorrect API key provided", type: "authentication_error", param: null, code: "invalid_api_key" },
    });
  });
});

// ── models ──────────────────────────────────────────────────────────────────

ok("GET /v1/models lists the live catalog", async () => {
  await withServer({}, async (base, fake) => {
    const res = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      object: "list",
      data: [
        { id: "auto", object: "model", created: 0, owned_by: "qoder" },
        { id: "ultimate", object: "model", created: 0, owned_by: "qoder" },
      ],
    });
    assert.equal(fake.state.listModelsCalls, 1);
  });
});

ok("an unavailable catalog is a 502, not an empty list", async () => {
  await withServer({ listModels: async () => null }, async (base) => {
    const res = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, "qoder_upstream_error");
  });
});

// ── chat: non-streaming ─────────────────────────────────────────────────────

ok("POST /v1/chat/completions non-streaming returns the completion JSON", async () => {
  await withServer({}, async (base, fake) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.content, "Hello!");
    assert.equal(fake.state.chatCompleteCalls, 1);
  });
});

// ── chat: streaming ─────────────────────────────────────────────────────────

ok("POST /v1/chat/completions streaming forwards SSE with [DONE]", async () => {
  await withServer({}, async (base, fake) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/event-stream");
    assert.equal(res.headers.get("X-Accel-Buffering"), "no");
    assert.equal(res.headers.get("Cache-Control"), "no-cache");
    const text = await res.text();
    assert.ok(text.includes('"role":"assistant"'));
    assert.ok(text.includes('"content":"Hi"'));
    assert.ok(text.trimEnd().endsWith("data: [DONE]"));
    assert.equal(fake.state.chatCalls, 1);
  });
});

ok("streaming upstream failure mid-stream emits an error frame + [DONE]", async () => {
  await withServer({
    chat: async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(chunk({ content: "partial" })));
          setTimeout(() => controller.error(new Error("upstream socket reset")), 20);
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    ),
  }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('"content":"partial"'));
    assert.ok(text.includes('"code":"qoder_stream_error"'), `expected error frame in: ${text}`);
    assert.ok(text.includes("Upstream stream failed"));
    assert.ok(text.trimEnd().endsWith("data: [DONE]"));
  });
});

// ── billing / usage ─────────────────────────────────────────────────────────

ok("GET /v1/dashboard/billing/subscription maps credits to the three limits", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/v1/dashboard/billing/subscription`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      object: "billing_subscription",
      has_payment_method: true,
      soft_limit_usd: 1000,
      hard_limit_usd: 1000,
      system_hard_limit_usd: 1000,
      access_until: 0,
    });
  });
});

ok("GET /v1/dashboard/billing/usage returns round(used × 100)", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/v1/dashboard/billing/usage?start_date=2026-08-01&end_date=2026-08-31`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { object: "list", total_usage: 30000 });
  });
});

ok("GET /v1/qoder/usage passes the native usage payload through", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/v1/qoder/usage`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), USAGE);
  });
});

// ── request validation ──────────────────────────────────────────────────────

ok("invalid JSON is a 400 invalid_json", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: jsonHeaders,
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "invalid_json");
  });
});

ok("invalid model and messages are 400s with distinct codes", async () => {
  await withServer({}, async (base) => {
    const noModel = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(noModel.status, 400);
    assert.equal((await noModel.json()).error.code, "invalid_model");

    const noMessages = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ model: "auto" }),
    });
    assert.equal(noMessages.status, 400);
    assert.equal((await noMessages.json()).error.code, "invalid_messages");
  });
});

ok("a non-object JSON body is rejected", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify([1, 2, 3]),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "invalid_json");
  });
});

ok("a non-JSON content type is a 415", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Authorization: `Bearer ${API_KEY}` },
      body: "hello",
    });
    assert.equal(res.status, 415);
    assert.equal((await res.json()).error.code, "unsupported_media_type");
  });
});

ok("bodies over 1 MiB are rejected with 413", async () => {
  await withServer({}, async (base) => {
    const big = JSON.stringify({ model: "auto", messages: [{ role: "user", content: "x".repeat(1024 * 1024) }] });
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: jsonHeaders,
      body: big,
    });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, "request_too_large");
  });
});

// ── routing ─────────────────────────────────────────────────────────────────

ok("unknown routes 404 and known paths with wrong methods 405", async () => {
  await withServer({}, async (base) => {
    const unknown = await fetch(`${base}/v1/nope`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, "not_found");

    const wrongMethod = await fetch(`${base}/v1/models`, { method: "POST", headers: { Authorization: `Bearer ${API_KEY}` } });
    assert.equal(wrongMethod.status, 405);
    assert.equal((await wrongMethod.json()).error.code, "method_not_allowed");

    const healthWrongMethod = await fetch(`${base}/health`, { method: "POST" });
    assert.equal(healthWrongMethod.status, 405);
  });
});

// ── upstream error mapping ──────────────────────────────────────────────────

ok("QoderBillingError maps to 429 insufficient_quota", async () => {
  await withServer({
    chatComplete: async () => {
      const error = new Error('{"code":"112","message":"quota exhausted"}');
      error.name = "QoderBillingError";
      throw error;
    },
  }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.error.type, "rate_limit_error");
    assert.equal(body.error.code, "insufficient_quota");
  });
});

ok("generic upstream failures map to 502 qoder_upstream_error", async () => {
  await withServer({
    chatComplete: async () => { throw new Error("qoder chat failed: HTTP 502 bad gateway"); },
  }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.type, "upstream_error");
    assert.equal(body.error.code, "qoder_upstream_error");
  });
});

ok("a Qoder auth rejection maps to 502 qoder_auth_error, not 401", async () => {
  await withServer({
    chatComplete: async () => { throw new Error("qoder PAT exchange failed: 401 unauthorized"); },
  }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });
    // The caller's adapter key was valid — this is an upstream credential issue.
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, "qoder_auth_error");
  });
});

// ── downstream disconnect ────────────────────────────────────────────────────

ok("a downstream disconnect aborts the upstream request", async () => {
  let upstreamSignal;
  await withServer({
    chat: async (body, options = {}) => {
      upstreamSignal = options.signal;
      const controller = new AbortController();
      options.signal?.addEventListener("abort", () => controller.abort(new Error("client disconnected")));
      return new Response(
        new ReadableStream({
          start(streamController) {
            streamController.enqueue(encoder.encode(chunk({ content: "begin" })));
            // Never completes on its own — only the abort ends it.
            controller.signal.addEventListener("abort", () => {
              try { streamController.error(new Error("aborted")); } catch { /* already closed */ }
            });
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    },
  }, async (base) => {
    const ac = new AbortController();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }], stream: true }),
      signal: ac.signal,
    });
    const reader = res.body.getReader();
    const { value } = await reader.read();
    assert.ok(new TextDecoder().decode(value).includes("begin"));

    ac.abort();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(upstreamSignal?.aborted, true, "upstream signal must be aborted after disconnect");
    // Reading further fails or ends — but must not hang forever.
    await reader.cancel().catch(() => {});
  });
});

ok("a disconnect during response backpressure cancels the upstream reader", async () => {
  let upstreamSignal;
  let upstreamCancelled = false;

  await withServer({
    chat: async (body, options = {}) => {
      upstreamSignal = options.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            // One chunk much larger than ServerResponse's write high-water
            // mark makes res.write() return false and parks the proxy on its
            // drain wait until the downstream closes.
            const prefix = chunk({ content: "begin" });
            controller.enqueue(encoder.encode(prefix + "x".repeat(1024 * 1024)));
          },
          cancel() {
            upstreamCancelled = true;
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    },
  }, async (base) => {
    const target = new URL(`${base}/v1/chat/completions`);
    const body = JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }], stream: true });

    await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          ...jsonHeaders,
          "Content-Length": Buffer.byteLength(body),
        },
      });
      req.on("error", (error) => {
        // ECONNRESET is expected after deliberately destroying the socket.
        if (error.code === "ECONNRESET") resolve();
        else reject(error);
      });
      req.on("response", (res) => {
        res.on("error", () => {});
        res.once("data", () => {
          res.destroy();
          req.destroy();
          resolve();
        });
      });
      req.end(body);
    });

    const deadline = Date.now() + 2000;
    while (!upstreamCancelled && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(upstreamSignal?.aborted, true, "disconnect must abort the upstream signal");
    assert.equal(upstreamCancelled, true, "proxy finally block must cancel the upstream reader");
  });
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

console.log(`\n${passed} server integration tests passed${failed ? `, ${failed} FAILED` : ""}`);
if (failed) process.exit(1);
