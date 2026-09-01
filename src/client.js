/**
 * QoderLiteClient — convenience wrapper tying auth, model catalog, and chat
 * requests together.
 *
 * Credentials use 9Router's connection-record shape:
 *   - PAT login:    { apiKey: "pt-..." }                       (auto-exchanged to a jt- job token)
 *   - Device login: { accessToken: "dt-...", providerSpecificData: { userId, machineId } }
 *   - Job token:    { accessToken: "jt-...", providerSpecificData: { userId } }
 *
 * The client instance carries its own model-catalog cache keys derived from
 * the resolved credential, so multiple instances on the same account share
 * the upstream fetch via the module-level coalescing in models.js.
 */

import { resolveQoderCredentials, isQoderPat } from "./pat.js";
import { resolveQoderModels, getQoderModelConfig, invalidateCatalog, clearCatalogCache, fetchQoderCatalogRaw } from "./models.js";
import { sendQoderChatRequest, unwrapQoderSSEResponse, QoderBillingError } from "./chat.js";
import { resolveAndFetchUsage } from "./usage.js";

export class QoderLiteClient {
  /**
   * @param {object} credentials  9Router-shaped credential record.
   * @param {object} [options]    { fetchImpl?, timeoutMs?, log? }
   */
  constructor(credentials, options = {}) {
    this.credentials = credentials;
    this.options = options;
  }

  get isPat() {
    return isQoderPat(this.credentials?.apiKey || this.credentials?.accessToken);
  }

  /**
   * Resolve credentials to COSY-signable form (PAT → job token + userId).
   * Useful once at startup to check the PAT is valid and cache the userId.
   */
  async resolveCredentials(options = {}) {
    return resolveQoderCredentials(this.credentials, { ...this.options, ...options });
  }

  /**
   * List models from the live catalog. Returns the cached resolveQoderModels
   * shape: { models: [...], rawConfigs: Map } | null.
   */
  async listModels(options = {}) {
    return resolveQoderModels(this.credentials, { ...this.options, ...options });
  }

  /**
   * Get the exact server-published model_config for a model key.
   */
  async getModelConfig(modelKey, options = {}) {
    return getQoderModelConfig(this.credentials, modelKey, { ...this.options, ...options });
  }

  /**
   * Send a chat request and get back a plain OpenAI SSE Response.
   *
   * @param {object} body  OpenAI-style chat body: { model, messages, max_tokens?, tools? }.
   *                       `model` accepts a bare key ("auto") or "qoder/auto".
   * @returns {Promise<Response>}  text/event-stream response with unwrapped
   *                               OpenAI chunks; consume with response.body.
   * @throws {QoderBillingError} on quota/billing blocks in the first frame.
   */
  async chat(body, options = {}) {
    const { response } = await sendQoderChatRequest({
      model: body.model,
      body,
      credentials: this.credentials,
      signal: options.signal,
      connectTimeoutMs: options.connectTimeoutMs,
      fetchImpl: this.options.fetchImpl,
      log: this.options.log,
    });
    return unwrapQoderSSEResponse(response, body.model);
  }

  /**
   * Chat as an async generator of parsed OpenAI chunks (convenience).
   * Terminates after the upstream [DONE] frame; upstream keepalive sockets
   * are cancelled automatically.
   */
  async *chatStream(body, options = {}) {
    const response = await this.chat(body, options);
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(`qoder chat failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data);
          } catch { /* skip malformed frame */ }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  /**
   * Non-streaming convenience: aggregates chatStream into a single
   * OpenAI-shaped chat.completion object (content concatenated, tool_calls
   * fragments joined by index, finish_reason/usage carried over).
   *
   * The upstream is always streamed under the hood (Qoder only supports
   * stream:true) — this just reassembles it client-side, mirroring what
   * 9Router's pipeline does for non-streaming clients.
   */
  async chatComplete(body, options = {}) {
    const model = body.model || "qoder/auto";
    const result = {
      id: `qoder-lite-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: "", tool_calls: [] },
        finish_reason: null,
      }],
      usage: null,
    };
    /** @type {Map<number, {id?, type?, function: {name?, arguments}}>} */
    const toolCalls = new Map();

    for await (const chunk of this.chatStream(body, options)) {
      if (chunk.usage) result.usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) result.choices[0].finish_reason = choice.finish_reason;
      const delta = choice.delta || {};
      if (typeof delta.content === "string") result.choices[0].message.content += delta.content;
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          let acc = toolCalls.get(idx);
          if (!acc) {
            acc = { id: "", type: "function", function: { name: "", arguments: "" } };
            toolCalls.set(idx, acc);
          }
          if (tc.id) acc.id = tc.id;
          if (tc.type) acc.type = tc.type;
          if (tc.function?.name) acc.function.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") acc.function.arguments += tc.function.arguments;
        }
      }
    }

    const joined = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    result.choices[0].message.tool_calls = joined.length ? joined : undefined;
    if (!result.choices[0].finish_reason) result.choices[0].finish_reason = "stop";
    return result;
  }

  /**
   * Fetch quota usage for this credential. PAT connections are exchanged to
   * a job token automatically before the request. Returns:
   *   { user: {total,used,remaining,unit},
   *     organization: {total,used,remaining,unit},
   *     totalUsagePercentage, isQuotaExceeded, expiresAt, resetAt }
   */
  async getUsage(options = {}) {
    return resolveAndFetchUsage(this.credentials, { ...this.options, ...options });
  }

  /** Drop this credential's cached model catalog. */
  invalidate() {
    invalidateCatalog(this.credentials);
  }
}

export { clearCatalogCache, fetchQoderCatalogRaw, QoderBillingError };
