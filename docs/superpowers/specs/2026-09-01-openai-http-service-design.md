# qoder-lite OpenAI-Compatible HTTP Service Design

**Date:** 2026-09-01

## 1. Goal

Extend `qoder-lite` with a standalone, zero-runtime-dependency HTTP service that exposes the existing Qoder client through OpenAI-compatible APIs. The service must support Chat Completions, model discovery, new-api-compatible balance queries, and a native Qoder usage endpoint.

The first version is a single-account deployment configured by environment variables. It is intended for direct use by new-api, Open WebUI, OpenAI SDK clients, and similar tools.

## 2. Scope

### Included

- Standalone Node.js HTTP server based on `node:http`.
- OpenAI-compatible `POST /v1/chat/completions` with streaming and non-streaming responses.
- OpenAI-compatible `GET /v1/models`.
- Legacy Dashboard Billing compatibility endpoints used by new-api.
- Native Qoder quota endpoint.
- Bearer-token authentication for all `/v1/*` routes.
- Request validation, bounded body parsing, OpenAI-shaped errors, credential redaction, and graceful shutdown.
- Regression fixes in existing client paths required for reliable server operation.
- Fully offline unit and integration tests using injected Qoder fetch implementations.

### Excluded

- Multiple Qoder accounts or per-user credential routing.
- Passing Qoder PATs directly from incoming client requests.
- Persistent databases or configuration files.
- Web UI or administration dashboard.
- Dollar conversion of Qoder credits.
- Historical usage filtering by requested date range.
- Broad CORS support.
- Express, Hono, or other HTTP framework dependencies.

## 3. Runtime Configuration

The server reads:

```env
QODER_PAT=pt-xxx
API_KEY=a-long-random-adapter-key
HOST=0.0.0.0
PORT=3000
```

Rules:

- `QODER_PAT` is required and must use the `pt-` prefix.
- `API_KEY` is required and must be non-empty.
- `HOST` defaults to `0.0.0.0`.
- `PORT` defaults to `3000` and must be an integer from 1 through 65535.
- Invalid configuration prevents startup.
- Startup output warns that the default host listens on every interface and that a strong API key is required.

A single `QoderLiteClient` instance is created at startup and reused for all requests so credential, token, and model caches remain effective.

## 4. Architecture

The server remains dependency-free and is split by responsibility:

```text
server.js
└── src/server/
    ├── config.js       # environment parsing and startup validation
    ├── auth.js         # Bearer extraction and constant-time API-key comparison
    ├── body.js         # bounded JSON request-body parsing
    ├── errors.js       # typed service errors and OpenAI error serialization
    ├── openai.js       # model and billing response conversion
    └── app.js          # HTTP routing, chat proxying, lifecycle-safe response handling
```

Responsibilities:

- `server.js` constructs the Qoder client, creates the server, listens, logs the bound address, and handles `SIGINT`/`SIGTERM`.
- `app.js` receives dependencies explicitly, allowing tests to inject a fake client without opening real Qoder connections.
- Conversion helpers contain no network behavior and are independently testable.
- The existing `QoderLiteClient` remains the only component that understands Qoder credentials and upstream request details.

## 5. Public HTTP API

### 5.1 Health

```http
GET /health
```

No authentication is required. It returns only process health:

```json
{
  "status": "ok"
}
```

It does not contact Qoder or disclose model, account, quota, configuration, or credential information.

### 5.2 Models

```http
GET /v1/models
Authorization: Bearer <API_KEY>
```

The service calls `client.listModels()` and converts the live catalog to:

```json
{
  "object": "list",
  "data": [
    {
      "id": "auto",
      "object": "model",
      "created": 0,
      "owned_by": "qoder"
    }
  ]
}
```

Model IDs remain unprefixed. Chat requests accept both `auto` and `qoder/auto` because the existing client normalizes the latter.

A missing or unavailable upstream catalog is a `502` error rather than an empty successful list.

### 5.3 Chat Completions

```http
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer <API_KEY>
```

Required request properties:

- The body must be a JSON object.
- `model` must be a non-empty string.
- `messages` must be an array.
- The JSON body is limited to 1 MiB.

The full validated body is passed to the existing client so currently supported fields such as `max_tokens`, `max_completion_tokens`, `tools`, and `tool_choice` remain available. Fields unsupported by Qoder may be ignored by the lower-level request builder; the server does not falsely claim full OpenAI parameter parity.

#### Non-streaming

When `stream` is false or absent, the service calls:

```js
client.chatComplete(body, { signal })
```

and returns an OpenAI-shaped `chat.completion` JSON object.

#### Streaming

When `stream` is true, the service calls:

```js
client.chat(body, { signal })
```

and forwards its already-unwrapped OpenAI SSE body with:

```http
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

The service preserves standard `data: {...}` frames and the terminal `data: [DONE]` frame. If the downstream client disconnects, the request AbortController is aborted and the upstream reader is cancelled.

If an error occurs before response headers are sent, the service sends an ordinary JSON error. If an upstream failure occurs after streaming has started, the service emits:

```text
data: {"error":{"message":"Upstream stream failed","type":"upstream_error","param":null,"code":"qoder_stream_error"}}

data: [DONE]

```

It does not attempt further writes after a downstream disconnect.

### 5.4 Dashboard Billing Subscription

```http
GET /v1/dashboard/billing/subscription
Authorization: Bearer <API_KEY>
```

The endpoint calls `client.getUsage()` and maps user credits numerically:

```json
{
  "object": "billing_subscription",
  "has_payment_method": true,
  "soft_limit_usd": 1000,
  "hard_limit_usd": 1000,
  "system_hard_limit_usd": 1000,
  "access_until": 0
}
```

All three limit fields equal `usage.user.total`.

The `_usd` field names are required by the legacy compatibility contract, but the values represent Qoder credits and are not real US dollars.

### 5.5 Dashboard Billing Usage

```http
GET /v1/dashboard/billing/usage?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
Authorization: Bearer <API_KEY>
```

The response is:

```json
{
  "object": "list",
  "total_usage": 30000
}
```

Mapping:

```text
total_usage = round(usage.user.used × 100)
```

The endpoint accepts date parameters for new-api compatibility but does not use them because Qoder provides only current quota-cycle totals, not arbitrary historical ranges.

### 5.6 Native Qoder Usage

```http
GET /v1/qoder/usage
Authorization: Bearer <API_KEY>
```

This returns `client.getUsage()` without monetary renaming:

```json
{
  "user": {
    "total": 1000,
    "used": 300,
    "remaining": 700,
    "unit": "credits"
  },
  "organization": {
    "total": 50000,
    "used": 50000,
    "remaining": 0,
    "unit": "credits"
  },
  "totalUsagePercentage": 30,
  "isQuotaExceeded": false,
  "expiresAt": 1781594470000,
  "resetAt": "2026-06-16T07:21:10.000Z"
}
```

## 6. Authentication and Security

- Every `/v1/*` request requires `Authorization: Bearer <API_KEY>`.
- `/health` is the only unauthenticated endpoint.
- API keys are compared using a constant-time comparison after normalizing both operands to equal-length buffers.
- Missing and incorrect keys return the same public response.
- JSON bodies are limited to 1 MiB before parsing.
- Chat requires an `application/json` content type.
- Every response sets `X-Content-Type-Options: nosniff`.
- The application does not enable permissive CORS.
- Responses never contain stack traces, PATs, Qoder access tokens, or adapter API keys.
- Logs redact Authorization values and strings beginning with `pt-`, `jt-`, or `dt-`.
- Signal handlers stop accepting new requests and close the HTTP server gracefully.

## 7. Error Contract

Errors use the OpenAI shape:

```json
{
  "error": {
    "message": "Specific error message",
    "type": "invalid_request_error",
    "param": null,
    "code": "invalid_json"
  }
}
```

Mapping:

| Condition | HTTP | Type | Code |
|---|---:|---|---|
| Missing or incorrect adapter key | 401 | `authentication_error` | `invalid_api_key` |
| Unknown route | 404 | `invalid_request_error` | `not_found` |
| Known path with unsupported method | 405 | `invalid_request_error` | `method_not_allowed` |
| Non-JSON Chat content type | 415 | `invalid_request_error` | `unsupported_media_type` |
| Invalid JSON | 400 | `invalid_request_error` | `invalid_json` |
| Invalid or missing `model` | 400 | `invalid_request_error` | `invalid_model` |
| Invalid or missing `messages` | 400 | `invalid_request_error` | `invalid_messages` |
| Body above 1 MiB | 413 | `invalid_request_error` | `request_too_large` |
| Qoder quota/billing block | 429 | `rate_limit_error` | `insufficient_quota` |
| Recognizable Qoder authentication rejection | 502 | `upstream_error` | `qoder_auth_error` |
| Qoder network/protocol/catalog failure | 502 | `upstream_error` | `qoder_upstream_error` |
| Unexpected local failure | 500 | `server_error` | `internal_error` |

The adapter key authenticates the local service. A bad upstream Qoder credential is therefore reported as an upstream failure, not as a claim that the caller's adapter key was invalid.

## 8. Required Client Reliability Fixes

The HTTP service depends on long-lived cancellation, token caching, and robust SSE parsing. The implementation therefore includes narrowly scoped fixes with regression tests:

1. Interpret PAT exchange `expires_in` as seconds and multiply by 1000.
2. Merge caller-provided AbortSignals with the internal timeout signal in `fetchWithTimeout()`.
3. Make the first-frame SSE probe consume and skip comments, blank lines, and non-data SSE fields instead of repeatedly examining the first line.
4. Propagate upstream stream failures rather than converting them into successful `[DONE]` completion.
5. Make model-cache invalidation work for PAT-backed clients by using a stable cache identity shared by unresolved and resolved credentials.
6. Make the existing smoke-test runner await asynchronous cases sequentially before reporting success.

No unrelated refactoring is included.

## 9. Testing

Tests remain fully offline and use only Node built-ins:

```text
test/
├── smoke.mjs
├── server-unit.mjs
└── server-integration.mjs
```

`test/smoke.mjs` continues to cover the low-level client and gains regressions for the six reliability fixes.

`test/server-unit.mjs` covers:

- environment defaults and validation;
- Bearer parsing and constant-time matching;
- OpenAI error serialization;
- model conversion;
- subscription conversion;
- usage conversion and rounding;
- sensitive-value redaction;
- Chat request validation.

`test/server-integration.mjs` starts a real Node HTTP server on an ephemeral loopback port with an injected fake client. It covers:

- unauthenticated `/health`;
- authenticated and unauthenticated `/v1/*` behavior;
- model listing;
- non-streaming Chat;
- streaming Chat and `[DONE]`;
- subscription balance;
- legacy usage balance;
- native Qoder usage;
- invalid JSON;
- invalid Chat parameters;
- unsupported content type;
- oversized request bodies;
- method and route errors;
- billing-error mapping;
- generic upstream-error mapping;
- downstream disconnect cancellation.

`npm test` runs the three scripts sequentially. No test performs a real Qoder request.

## 10. Documentation and Operation

The README gains:

- environment-variable reference;
- startup command;
- curl examples for every endpoint;
- OpenAI SDK/base URL usage example;
- new-api channel and balance-query notes;
- an explicit warning that billing `_usd` fields carry Qoder credits;
- deployment advice for `0.0.0.0`, API-key strength, TLS termination, and reverse proxies;
- supported and unsupported Chat parameters.

The package adds a start script while retaining the current direct library exports:

```json
{
  "scripts": {
    "start": "node server.js",
    "test": "node test/smoke.mjs && node test/server-unit.mjs && node test/server-integration.mjs"
  }
}
```

The existing library API remains backward compatible.

## 11. Acceptance Criteria

The feature is complete when:

1. `QODER_PAT=pt-... API_KEY=... npm start` starts the server on `0.0.0.0:3000` by default.
2. Every documented endpoint returns the specified success shape.
3. OpenAI-compatible clients can perform both streaming and non-streaming Chat Completions.
4. new-api can list models and calculate a numeric balance using the two legacy billing endpoints.
5. Invalid credentials, invalid requests, quota blocks, and upstream failures produce the defined OpenAI error shapes.
6. Client disconnects cancel upstream streaming work.
7. Existing client behavior remains available through `index.js`.
8. All tests pass without network access or third-party packages.
