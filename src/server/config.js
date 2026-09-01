/**
 * Server environment parsing and startup validation.
 *
 * Rules (design doc §3):
 *   - QODER_PAT is required and must use the `pt-` prefix.
 *   - API_KEY is required and must be non-empty.
 *   - HOST defaults to `0.0.0.0`.
 *   - PORT defaults to `3000` and must be an integer 1–65535.
 *   - Invalid configuration prevents startup.
 */

export class ConfigError extends Error {
  constructor(problems) {
    super(`invalid server configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export function loadServerConfig(env = process.env) {
  const problems = [];

  const qoderPat = String(env.QODER_PAT ?? "").trim();
  if (!qoderPat) problems.push("QODER_PAT is required");
  else if (!qoderPat.startsWith("pt-")) problems.push("QODER_PAT must use the pt- prefix (got a token that does not start with \"pt-\")");

  const apiKey = String(env.API_KEY ?? "").trim();
  if (!apiKey) problems.push("API_KEY is required");

  const host = String(env.HOST ?? "").trim() || "0.0.0.0";

  const portRaw = String(env.PORT ?? "").trim() || "3000";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`PORT must be an integer from 1 through 65535 (got "${portRaw}")`);
  }

  if (problems.length) throw new ConfigError(problems);
  return { qoderPat, apiKey, host, port };
}
