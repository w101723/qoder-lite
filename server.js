#!/usr/bin/env node
/**
 * qoder-lite OpenAI-compatible HTTP service.
 *
 *   QODER_PAT=pt-... API_KEY=... npm start
 *
 * Exposes the Qoder client through /v1/chat/completions, /v1/models, the
 * legacy new-api billing endpoints, and /v1/qoder/usage. Single-account,
 * environment-configured, and zero runtime dependencies.
 */

import http from "node:http";

import { QoderLiteClient } from "./index.js";
import { QODER_SOURCE } from "./src/constants.js";
import { loadServerConfig } from "./src/server/config.js";
import { createRequestHandler } from "./src/server/app.js";
import { createTimestampLogger } from "./src/server/logger.js";
import { CredentialManager } from "./src/credentialManager.js";

// Log through an injected formatter, not global console replacement.
const log = createTimestampLogger(console);

async function main() {
  let config;
  try {
    config = loadServerConfig(process.env);
  } catch (error) {
    log.error(`[qoder-lite] ${error.message}`);
    process.exit(1);
  }

  if (config.host === "0.0.0.0" || config.host === "::") {
    log.warn(
      `[qoder-lite] HOST=${config.host} listens on EVERY network interface. ` +
      "Restrict HOST to a loopback address or front the service with a firewall / TLS reverse proxy.",
    );
  }
  if (config.apiKey.length < 32) {
    log.warn(
      "[qoder-lite] API_KEY is shorter than 32 characters — use a long random key " +
      "(e.g. `openssl rand -hex 32`).",
    );
  }

  if (QODER_SOURCE !== config.source) {
    throw new Error("SOURCE configuration disagrees with loaded Qoder upstream");
  }

  const credentials = new CredentialManager({ pat: config.qoderPat, authFile: config.authFile, log });
  await credentials.initiate();
  const client = new QoderLiteClient({}, { log, credentialManager: credentials });

  const server = http.createServer(createRequestHandler({ client, apiKey: config.apiKey, log }));

  server.listen(config.port, config.host, () => {
    log.log(`[qoder-lite] listening on http://${config.host}:${config.port} (SOURCE=${config.source})`);
    log.log("[qoder-lite] endpoints: /health, /v1/models, /v1/chat/completions, /v1/dashboard/billing/*, /v1/qoder/usage");
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.log(`[qoder-lite] ${signal} received — stopping (waiting up to 10s for in-flight requests)`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => { console.error("[qoder-lite] startup failed:", err.message); process.exitCode = 1; });
