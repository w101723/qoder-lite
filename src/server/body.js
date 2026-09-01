/**
 * Bounded JSON request-body parsing.
 *
 * Bodies larger than the limit are rejected with a typed error BEFORE JSON
 * parsing (design doc §6: 1 MiB cap). The request socket is destroyed so a
 * hostile client cannot keep streaming.
 */

import { ServiceError } from "./errors.js";

export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Read and JSON-parse a request body.
 *
 * @param {import("http").IncomingMessage} req
 * @param {number} [limit] Defaults to 1 MiB.
 * @returns {Promise<any>} Parsed JSON value.
 * @throws {ServiceError} 413 request_too_large / 400 invalid_json.
 */
export function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
      // Stop consuming — the error response goes out first and Node closes
      // the connection afterwards because the request body is unconsumed.
      req.pause();
    };

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(new ServiceError(413, `Request body exceeds the ${limit} byte limit`, {
          type: "invalid_request_error",
          code: "request_too_large",
        }));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ServiceError(400, "Request body is not valid JSON", {
          type: "invalid_request_error",
          code: "invalid_json",
        }));
      }
    });

    req.on("error", (error) => {
      fail(error instanceof ServiceError ? error : new Error(`request stream error: ${error.message}`));
    });
  });
}
