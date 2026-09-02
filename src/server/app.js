/**
 * HTTP routing, chat proxying, and lifecycle-safe response handling.
 *
 * `createRequestHandler` receives its dependencies explicitly ({ client,
 * apiKey, log }) so tests can inject a fake client without opening real
 * Qoder connections. The client is duck-typed: listModels / chat /
 * chatComplete / getUsage.
 */

import { extractBearerToken, isApiKeyValid } from "./auth.js";
import { readJsonBody } from "./body.js";
import { ServiceError, toServiceError, redactSecrets } from "./errors.js";
import {
  toOpenAiModelList,
  toBillingSubscription,
  toBillingUsage,
  toCreditGrants,
} from "./openai.js";

const STREAM_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no",
};

/** route → allowed method(s). Any other method on a known path is a 405. */
const ROUTES = {
  "/health": "GET",
  "/v1/models": "GET",
  "/v1/chat/completions": "POST",
  "/v1/dashboard/billing/subscription": "GET",
  "/v1/dashboard/billing/usage": "GET",
  "/v1/dashboard/billing/credit_grants": "GET",
  "/v1/qoder/usage": "GET",
};

/**
 * Validate an OpenAI-style chat body. Returns "model", "messages", or "body"
 * for the first failing property; null when valid.
 */
export function validateChatBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body";
  if (typeof body.model !== "string" || !body.model.trim()) return "model";
  if (!Array.isArray(body.messages)) return "messages";
  return null;
}

function sendJson(res, status, payload) {
  if (res.headersSent) {
    try { res.end(); } catch { /* already closed */ }
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendServiceError(res, error) {
  const serviceError = toServiceError(error);
  sendJson(res, serviceError.status, serviceError.toJSON());
}

/** Abort the request work when the downstream client disappears. */
function wireDisconnectAbort(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableEnded) controller.abort(new Error("client disconnected"));
  };
  res.on("close", abort);
  req.on("aborted", abort);
  return controller;
}

/**
 * Wait for a backpressured response socket to drain, but always settle when
 * the downstream closes or errors. Without the close/error branches a client
 * disconnect during backpressure leaves the handler parked forever and its
 * upstream reader is never cancelled.
 */
function waitForDrainOrClose(res) {
  return new Promise((resolve) => {
    // Check before registering: once a writable is destroyed it will not emit
    // a future drain (and close may already have fired).
    if (res.destroyed || res.writableEnded) {
      resolve();
      return;
    }

    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      res.off("error", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
    res.once("error", done);
  });
}

async function handleChat(req, res, client) {
  const contentType = String(req.headers["content-type"] || "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ServiceError(415, `Chat completions require Content-Type: application/json (got "${contentType || "none"}")`, {
      type: "invalid_request_error",
      code: "unsupported_media_type",
    });
  }

  const body = await readJsonBody(req);
  const invalid = validateChatBody(body);
  if (invalid === "body") {
    throw new ServiceError(400, "Request body must be a JSON object", {
      type: "invalid_request_error",
      code: "invalid_json",
    });
  }
  if (invalid === "model") {
    throw new ServiceError(400, "\"model\" must be a non-empty string (e.g. \"auto\" or \"qoder/auto\")", {
      type: "invalid_request_error",
      code: "invalid_model",
    });
  }
  if (invalid === "messages") {
    throw new ServiceError(400, "\"messages\" must be an array of chat messages", {
      type: "invalid_request_error",
      code: "invalid_messages",
    });
  }

  const controller = wireDisconnectAbort(req, res);

  if (body.stream === true) {
    let response;
    try {
      response = await client.chat(body, { signal: controller.signal });
    } catch (error) {
      throw toServiceError(error);
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new ServiceError(502, `Qoder upstream chat failed: HTTP ${response.status} ${text.slice(0, 200)}`, {
        type: "upstream_error",
        code: "qoder_upstream_error",
      });
    }

    res.writeHead(200, STREAM_HEADERS);

    const reader = response.body.getReader();
    // Cancel the body reader immediately when the downstream disconnects.
    // Do not rely solely on fetch propagating its AbortSignal: injected or
    // non-standard response streams may ignore that signal, and the pump may
    // currently be parked on backpressure rather than reader.read().
    const cancelReader = () => {
      reader.cancel(controller.signal.reason).catch(() => {});
    };
    if (controller.signal.aborted) cancelReader();
    else controller.signal.addEventListener("abort", cancelReader, { once: true });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (res.writableEnded || res.destroyed) break;
        if (!res.write(value)) {
          await waitForDrainOrClose(res);
          if (res.writableEnded || res.destroyed) break;
        }
      }
      res.end();
    } catch (error) {
      // Upstream failed mid-stream (or the client vanished — in which case
      // writes are skipped: no further writes after a downstream disconnect).
      if (!controller.signal.aborted && !res.destroyed && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({
          error: {
            message: "Upstream stream failed",
            type: "upstream_error",
            param: null,
            code: "qoder_stream_error",
          },
        })}\n\n`);
        res.write("data: [DONE]\n\n");
      }
      try { res.end(); } catch { /* already closed */ }
    } finally {
      controller.signal.removeEventListener("abort", cancelReader);
      await reader.cancel().catch(() => {});
    }
    return;
  }

  // Non-streaming: the client aggregates the upstream stream itself.
  const completion = await client.chatComplete(body, { signal: controller.signal });
  sendJson(res, 200, completion);
}

async function handleUsageRoute(res, client, convert) {
  const usage = await client.getUsage();
  if (!usage || !usage.user) {
    throw new ServiceError(502, "Qoder usage is unavailable (no quota data returned)", {
      type: "upstream_error",
      code: "qoder_upstream_error",
    });
  }
  sendJson(res, 200, convert(usage));
}

async function handleModels(res, client) {
  const catalog = await client.listModels();
  if (!catalog || !Array.isArray(catalog.models)) {
    throw new ServiceError(502, "Qoder model catalog is unavailable", {
      type: "upstream_error",
      code: "qoder_upstream_error",
    });
  }
  sendJson(res, 200, toOpenAiModelList(catalog));
}

export function createRequestHandler({ client, apiKey, log = console }) {
  if (!client) throw new Error("createRequestHandler requires a client");
  if (!apiKey) throw new Error("createRequestHandler requires an apiKey");

  return async function handle(req, res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    const pathname = new URL(req.url, "http://localhost").pathname;

    try {
      if (pathname === "/health") {
        if (req.method !== "GET") {
          throw new ServiceError(405, `Method ${req.method} is not allowed for /health`, {
            type: "invalid_request_error",
            code: "method_not_allowed",
          });
        }
        return sendJson(res, 200, { status: "ok" });
      }

      if (pathname.startsWith("/v1/")) {
        // Every /v1/* route requires the adapter key — check it before
        // revealing whether a route exists.
        const token = extractBearerToken(req);
        if (!token || !isApiKeyValid(token, apiKey)) {
          throw new ServiceError(401, "Incorrect API key provided", {
            type: "authentication_error",
            code: "invalid_api_key",
          });
        }

        const allowed = ROUTES[pathname];
        if (!allowed) {
          throw new ServiceError(404, `Unknown route: ${req.method} ${pathname}`, {
            type: "invalid_request_error",
            code: "not_found",
          });
        }
        if (req.method !== allowed) {
          throw new ServiceError(405, `Method ${req.method} is not allowed for ${pathname} (use ${allowed})`, {
            type: "invalid_request_error",
            code: "method_not_allowed",
          });
        }

        switch (pathname) {
          case "/v1/models":
            return await handleModels(res, client);
          case "/v1/chat/completions":
            return await handleChat(req, res, client);
          case "/v1/dashboard/billing/subscription":
            return await handleUsageRoute(res, client, toBillingSubscription);
          case "/v1/dashboard/billing/usage":
            return await handleUsageRoute(res, client, toBillingUsage);
          case "/v1/dashboard/billing/credit_grants":
            return await handleUsageRoute(res, client, toCreditGrants);
          case "/v1/qoder/usage":
            return await handleUsageRoute(res, client, (usage) => usage);
          default:
            throw new ServiceError(404, `Unknown route: ${req.method} ${pathname}`, {
              type: "invalid_request_error",
              code: "not_found",
            });
        }
      }

      throw new ServiceError(404, `Unknown route: ${req.method} ${pathname}`, {
        type: "invalid_request_error",
        code: "not_found",
      });
    } catch (error) {
      const serviceError = toServiceError(error);
      if (serviceError.status >= 500) {
        log.error?.(redactSecrets(`qoder-lite: ${req.method} ${pathname} failed: ${error?.stack || error?.message || error}`));
      }
      sendServiceError(res, error);
    }
  };
}
