#!/usr/bin/env node
/**
 * qoder-lite OpenAI-compatible HTTP service.
 *
 *   QODER_PAT=pt-... API_KEY=... npm start
 *
 * Exposes the Qoder client through /v1/chat/completions, /v1/models, the
 * legacy new-api billing endpoints, and /v1/qoder/usage. Single-account,
 * environment-configured, zero runtime dependencies (design doc:
 * docs/superpowers/specs/2026-09-01-openai-http-service-design.md).
 */

import http from "node:http";

import { QoderLiteClient } from "./index.js";
import { loadServerConfig } from "./src/server/config.js";
import { createRequestHandler } from "./src/server/app.js";

function main() {
  let config;
  try {
    config = loadServerConfig(process.env);
  } catch (error) {
    console.error(`[qoder-lite] ${error.message}`);
    process.exit(1);
  }

  if (config.host === "0.0.0.0" || config.host === "::") {
    console.warn(
      `[qoder-lite] HOST=${config.host} listens on EVERY network interface. ` +
      "Restrict HOST to a loopback address or front the service with a firewall / TLS reverse proxy.",
    );
  }
  if (config.apiKey.length < 32) {
    console.warn(
      "[qoder-lite] API_KEY is shorter than 32 characters — use a long random key " +
      "(e.g. `openssl rand -hex 32`).",
    );
  }

  // One client instance for the whole process so credential, token, and
  // model caches stay effective across requests.
  const client = new QoderLiteClient(
    { apiKey: config.qoderPat, providerSpecificData: {} },
    {},
  );

  const server = http.createServer(createRequestHandler({ client, apiKey: config.apiKey }));

  server.listen(config.port, config.host, () => {
    console.log(`[qoder-lite] listening on http://${config.host}:${config.port}`);
    console.log("[qoder-lite] endpoints: /health, /v1/models, /v1/chat/completions, /v1/dashboard/billing/*, /v1/qoder/usage");
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[qoder-lite] ${signal} received — stopping (waiting up to 10s for in-flight requests)`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
