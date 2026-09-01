/**
 * Qoder chat request plumbing — extracted from 9Router's
 * open-sse/executors/qoder.js (request-body builder + SSE envelope unwrap).
 *
 * The request shape Qoder expects is non-trivial (chat_context with
 * mirrored modelConfig, business block with stable IDs, system text
 * hoisted out of the messages array). Model identifier is one of the
 * canonical Qoder keys (auto / ultimate / performance / efficient /
 * lite + frontier "*model" ids); a "qoder/<key>" prefix is stripped.
 *
 * Per-model `model_config` is fetched live from /algo/api/v2/model/list
 * and cached. Sending the wrong block silently downgrades to a different
 * model upstream, so a missing entry is a hard error.
 */

import crypto from "crypto";

import { qoderEncodeBody } from "./encoding.js";
import { buildCosyHeaders } from "./cosy.js";
import { resolveQoderCredentials, isQoderPat, isQoderJobToken } from "./pat.js";
import { getQoderModelConfig, resolveQoderModels } from "./models.js";
import { withConnectTimeout } from "./http.js";
import {
  QODER_CHAT_URL_ENCODED,
  QODER_CHAT_BASE_ALT,
  QODER_CHAT_SIG_PATH,
} from "./constants.js";

/**
 * Pick the chat URL for the resolved credential. Job-token (jt-...) traffic
 * must hit api2.qoder.sh — api3 rejects jt- with "Login expired" (403).
 * Device tokens (dt-...) stay on api3.
 */
export function buildChatUrl(credentials) {
  const token = credentials?.accessToken || "";
  if (isQoderJobToken(token)) {
    return `${QODER_CHAT_BASE_ALT}/algo${QODER_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
  }
  return QODER_CHAT_URL_ENCODED;
}

/**
 * Hoist role:"system" messages out of the messages array (Qoder rejects
 * system in messages) and flatten any multipart content arrays.
 */
export function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], systemText: "" };
  }
  const systemParts = [];
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const text = extractText(msg.content);
    if (msg.role === "system") {
      if (text) systemParts.push(text);
      continue;
    }
    const cloned = { ...msg };
    cloned.content = text;
    out.push(cloned);
  }
  return { messages: out, systemText: systemParts.join("\n\n") };
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (item && typeof item === "object") {
        if (item.type === "text" && typeof item.text === "string") {
          parts.push(item.text);
        } else if (typeof item.text === "string") {
          parts.push(item.text);
        }
      }
    }
    return parts.join("\n");
  }
  return String(content);
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && typeof m.content === "string") {
      return m.content;
    }
  }
  return "";
}

function stableHash(prefix, ...parts) {
  const h = crypto.createHash("sha256");
  h.update(prefix);
  for (const p of parts) {
    h.update("\0");
    h.update(String(p ?? ""));
  }
  return h.digest("hex").slice(0, 16);
}

function stableChatRecordId(model, messages, tools, maxTokens) {
  const h = crypto.createHash("sha256");
  h.update("qoder-record\0");
  h.update(String(model));
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role) { h.update("\0"); h.update(m.role); }
    if (typeof m.content === "string" && m.content) {
      h.update("\0"); h.update(m.content);
    }
  }
  if (tools) {
    h.update("\0");
    try { h.update(JSON.stringify(tools)); } catch {}
  }
  h.update(`\0mt=${maxTokens}`);
  return h.digest("hex").slice(0, 16);
}

function truncate(s, n) {
  return s && s.length > n ? `${s.slice(0, n)}...` : s || "";
}

/**
 * Map the OpenAI-style request body into the exact shape Qoder expects.
 */
export async function buildQoderRequestBody({ model, body, credentials, options = {} }) {
  const qoderKey = String(model || "").replace(/^qoder\//, "");

  // Fetch model config from the live catalog instead of a static map —
  // this supports new Qoder models without code changes.
  let modelConfig = await getQoderModelConfig(credentials, qoderKey, options);
  if (!modelConfig) {
    // Try a forced refresh once before giving up — the cache may simply
    // not be populated yet on first ever call for this credential.
    const refreshed = await resolveQoderModels(credentials, { ...options, forceRefresh: true });
    const retried = refreshed?.rawConfigs.get(qoderKey);
    if (!retried) {
      throw new Error(
        `qoder: model_config for "${qoderKey}" not yet known (run a model list fetch or check upstream connectivity)`,
      );
    }
    modelConfig = { ...retried, key: qoderKey };
  }

  const { messages, systemText } = normalizeMessages(body.messages || []);
  const tools = body.tools;
  const isReasoning = !!modelConfig.is_reasoning;
  const maxOutputTokens = Number(modelConfig.max_output_tokens) || 0;

  let maxTokens = 32_768;
  if (maxOutputTokens > 0) maxTokens = maxOutputTokens;
  if (typeof body.max_tokens === "number" && body.max_tokens > 0 && body.max_tokens < maxTokens) {
    maxTokens = body.max_tokens;
  }
  if (typeof body.max_completion_tokens === "number" && body.max_completion_tokens > 0 && body.max_completion_tokens < maxTokens) {
    maxTokens = body.max_completion_tokens;
  }

  const lastUser = lastUserText(messages);
  const psd = credentials.providerSpecificData || {};
  const sessionId = stableHash("qoder-session", psd.userId, qoderKey);
  const recordId = stableChatRecordId(qoderKey, messages, tools, maxTokens);

  return {
    qoderKey,
    payload: {
      request_id: crypto.randomUUID(),
      request_set_id: recordId,
      chat_record_id: recordId,
      session_id: sessionId,
      stream: true,
      chat_task: "FREE_INPUT",
      is_reply: true,
      is_retry: false,
      source: 1,
      version: "3",
      session_type: "qodercli",
      agent_id: "agent_common",
      task_id: "common",
      code_language: "",
      chat_prompt: "",
      image_urls: null,
      aliyun_user_type: "",
      system: systemText,
      messages,
      tools: Array.isArray(tools) ? tools : [],
      parameters: { max_tokens: maxTokens },
      chat_context: {
        chatPrompt: "",
        imageUrls: null,
        extra: {
          context: [],
          modelConfig: { key: qoderKey, is_reasoning: isReasoning },
          originalContent: lastUser,
        },
        features: [],
        text: lastUser,
      },
      model_config: modelConfig,
      business: {
        product: "cli",
        version: "1.0.0",
        type: "agent",
        stage: "start",
        id: crypto.randomUUID(),
        name: truncate(lastUser, 30),
        begin_at: Date.now(),
      },
    },
    modelConfig,
  };
}

/**
 * Check if a qoder error message indicates a billing/quota block.
 * Signatures: code 112 (quota exhausted), code 10605 (queue throttle),
 * pricingUrl field.
 */
export function isBillingBlock(inner) {
  if (!inner || typeof inner !== "string") return false;
  const lowerMsg = inner.toLowerCase();
  // Match: {"code":"112",...}, {"code":"10605",...}, or pricingUrl field
  return /\"code\"\s*:\s*\"(112|10605)\"/.test(inner) || lowerMsg.includes("pricingurl");
}

/**
 * Send a chat request to Qoder and return the raw (unwrapped) upstream SSE
 * response. Handles, in order:
 *   1. PAT → job-token exchange (dt-/jt- tokens are used directly)
 *   2. request body built from the OpenAI-style payload + live model_config
 *   3. body encoded with qoderEncodeBody (WAF bypass) and sent with &Encode=1
 *   4. COSY headers built from the *encoded* body bytes
 *
 * Use `unwrapQoderSSEResponse` on the result to get plain OpenAI SSE.
 *
 * @param {object} params
 * @param {string} params.model              Qoder model key or "qoder/<key>".
 * @param {object} params.body               OpenAI-style chat body (messages, tools, max_tokens...).
 * @param {object} params.credentials        9Router-shaped credential record (PAT or dt-/jt- token).
 * @param {AbortSignal} [params.signal]
 * @param {number} [params.connectTimeoutMs] Defaults to 120s (registry value).
 * @param {Function} [params.fetchImpl]      Injectable fetch (defaults to globalThis.fetch).
 * @param {object} [params.log]              Optional { warn } logger.
 */
export async function sendQoderChatRequest({ model, body, credentials, signal, connectTimeoutMs = 120_000, fetchImpl, log }) {
  const fetch_ = fetchImpl || globalThis.fetch;

  // PAT (pt-...) → exchange for short-lived job token + resolve userId so
  // downstream COSY signing + catalog fetch work. Device tokens (dt-...) and
  // job tokens (jt-...) skip this and are used directly.
  const rawToken = credentials?.apiKey || credentials?.accessToken;
  let resolved = credentials;
  if (isQoderPat(rawToken)) {
    resolved = await resolveQoderCredentials(credentials, { signal, fetchImpl, log });
  }

  const url = buildChatUrl(resolved);
  const psd = resolved?.providerSpecificData || {};
  if (!psd.userId) {
    throw new Error("qoder credential is missing userId; reconnect the account");
  }
  if (!resolved?.accessToken) {
    throw new Error("qoder credential is missing accessToken; reconnect the account");
  }

  const { qoderKey, payload } = await buildQoderRequestBody({
    model,
    body,
    credentials: resolved,
    options: { signal, fetchImpl, log },
  });

  const plainBody = Buffer.from(JSON.stringify(payload), "utf8");
  const encodedBodyStr = qoderEncodeBody(plainBody);
  const encodedBodyBuf = Buffer.from(encodedBodyStr, "latin1");

  // cosy.js throws synchronously on missing userId/authToken.
  const cosyHeaders = buildCosyHeaders(encodedBodyBuf, url, {
    userId: psd.userId,
    authToken: resolved.accessToken,
    name: resolved.displayName || "",
    email: resolved.email || "",
    machineId: psd.machineId || "",
  });

  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Model-Key": qoderKey,
    "X-Model-Source": (payload.model_config && payload.model_config.source) || "system",
    // gzip triggers signature validation on Qoder's CDN; force identity.
    "Accept-Encoding": "identity",
    ...cosyHeaders,
  };

  const { signal: mergedSignal, cleanup } = withConnectTimeout(signal, connectTimeoutMs);
  let response;
  try {
    response = await fetch_(url, { method: "POST", headers, body: encodedBodyBuf, signal: mergedSignal });
  } finally {
    cleanup();
  }

  return { response, qoderKey, payload, url };
}

/**
 * Wrap the upstream's `{statusCodeValue, body}` SSE envelope into plain
 * OpenAI SSE chunks. Each upstream line looks like:
 *
 *   data: {"statusCodeValue":200,"body":"{\"choices\":[{\"delta\":{...}}]}"}
 *
 * The inner body is an OpenAI streaming chunk (or "[DONE]"). We unwrap it
 * and re-emit as `data: <inner>\n\n`. Non-200 envelopes become a synthetic
 * OpenAI error chunk + [DONE]. Billing/quota blocks (code 112/10605,
 * pricingUrl) throw QoderBillingError so callers can trigger fallback.
 *
 * Critical: Qoder's SSE often keeps the socket open after the terminal
 * [DONE]/error frame (agent keepalive), so on terminal events we cancel
 * the upstream reader and close our stream immediately.
 */
export async function unwrapQoderSSEResponse(response, model) {
  if (!response.ok || !response.body) return response;

  const decoder = new TextDecoder();
  const reader = response.body.getReader();

  // Peek the first frame to surface billing blocks as an exception.
  const peek = await peekFirstQoderFrame(reader, decoder);
  if (peek?.isBilling) {
    await reader.cancel().catch(() => {});
    throw new QoderBillingError(peek.message, peek.statusVal);
  }

  // Normal flow: re-process every byte the peek consumed, then continue.
  let buffer = peek.consumed || "";
  const upstreamDrained = peek.upstreamDone === true;
  const encoder = new TextEncoder();
  let doneEmitted = false;

  const processLine = (line, controller) => {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("data:")) return;
    if (doneEmitted) return;

    const data = trimmed.slice(5).trimStart();
    if (data === "[DONE]") {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      doneEmitted = true;
      return;
    }

    let envelope;
    try { envelope = JSON.parse(data); } catch { return; }
    const statusVal = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
    const inner = typeof envelope.body === "string" ? envelope.body : "";
    if (statusVal !== 200) {
      const msg = inner || `upstream status ${statusVal}`;
      const errChunk = JSON.stringify({
        id: `qoder-error-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: `\n[qoder error ${statusVal}: ${truncate(msg, 200)}]` }, finish_reason: "stop" }],
      });
      controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      doneEmitted = true;
      return;
    }
    if (!inner) return;
    if (inner === "[DONE]") {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      doneEmitted = true;
      return;
    }
    // Strip embedded newlines so the SSE frame stays a single event.
    const sanitized = inner.replace(/\r?\n/g, "");
    controller.enqueue(encoder.encode(`data: ${sanitized}\n\n`));
  };

  const stream = new ReadableStream({
    // Use start()+loop (not pull): a pull that buffers a partial line without
    // enqueueing would never be re-invoked, hanging consumers like .text().
    async start(controller) {
      let upstreamError = null;
      try {
        // Drain whatever the peek already pulled off the socket first.
        let nlSeed;
        while ((nlSeed = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nlSeed);
          buffer = buffer.slice(nlSeed + 1);
          processLine(line, controller);
          if (doneEmitted) {
            await reader.cancel().catch(() => {});
            controller.close();
            return;
          }
        }
        if (upstreamDrained) {
          // Peek hit end-of-stream: flush any trailing partial line.
          buffer += decoder.decode();
          if (buffer.length > 0) {
            processLine(buffer, controller);
            buffer = "";
          }
        }

        while (!doneEmitted && !upstreamDrained) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            if (buffer.length > 0) {
              processLine(buffer, controller);
              buffer = "";
            }
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            processLine(line, controller);
            if (doneEmitted) {
              // Terminal frame received — drop upstream keepalive and end.
              await reader.cancel().catch(() => {});
              controller.close();
              return;
            }
          }
        }
      } catch (error) {
        // A failed upstream read must NOT become a successful [DONE] —
        // remember it and propagate after cleanup so consumers can tell a
        // truncated stream apart from a normal completion.
        upstreamError = error;
      } finally {
        await reader.cancel().catch(() => {});
      }

      if (upstreamError) {
        try { controller.error(upstreamError); } catch { /* already closed */ }
        return;
      }

      if (!doneEmitted) {
        // Upstream ended without a terminal frame — still close cleanly.
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          doneEmitted = true;
        } catch { /* already closed */ }
      }
      try { controller.close(); } catch { /* already closed */ }
    },
    cancel() {
      return reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

/**
 * Peek the first SSE data frame to detect billing errors before piping.
 * Comments (`: heartbeat`), blank lines, and non-data fields (`event:`,
 * `id:`) are consumed and skipped — the scan position advances past each
 * examined line so a leading heartbeat can never loop forever. Returns
 * { isBilling, statusVal, message, consumed } — `consumed` is every byte
 * read so far (including skipped lines) so the caller can re-process it
 * and nothing is dropped from the stream.
 */
async function peekFirstQoderFrame(reader, decoder) {
  let consumed = "";
  let scanned = 0;
  while (true) {
    const nl = consumed.indexOf("\n", scanned);
    if (nl === -1) {
      const { done, value } = await reader.read();
      if (done) return { isBilling: false, consumed, upstreamDone: true };
      consumed += decoder.decode(value, { stream: true });
      continue; // need a full line first
    }

    const line = consumed.slice(scanned, nl).replace(/\r$/, "").trim();
    scanned = nl + 1;
    if (!line.startsWith("data:")) continue;

    const data = line.slice(5).trimStart();
    if (data === "[DONE]") return { isBilling: false, consumed };

    let envelope;
    try { envelope = JSON.parse(data); } catch { return { isBilling: false, consumed }; }

    const statusVal = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
    const inner = typeof envelope.body === "string" ? envelope.body : "";

    if (statusVal !== 200 && isBillingBlock(inner)) {
      return { isBilling: true, statusVal, message: inner || `qoder billing block (${statusVal})` };
    }
    return { isBilling: false, consumed };
  }
}

/** Thrown when the first upstream frame signals a quota/billing block. */
export class QoderBillingError extends Error {
  constructor(message, statusVal) {
    super(message);
    this.name = "QoderBillingError";
    this.statusVal = statusVal;
  }
}
