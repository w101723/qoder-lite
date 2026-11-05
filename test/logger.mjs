import assert from "node:assert/strict";
import { createTimestampLogger } from "../src/server/logger.js";

const writes = [];
const sink = Object.fromEntries(["log", "info", "warn", "error", "debug"].map(level => [level, (...args) => writes.push({ level, args })]));
let ticks = 0;
const logger = createTimestampLogger(sink, () => { ticks++; return new Date("2026-11-05T11:12:30.123Z"); });
const problem = new Error("upstream 403");
logger.log("[qoder-lite] started");
logger.info("[qoder-lite] info", { requestId: "r1" });
logger.warn("[qoder-lite] upstream 403", "attempt 1/9");
logger.error("[qoder-lite] image upload HTTP 403", problem);
logger.debug("trace");
assert.equal(writes.length, 5);
assert.equal(ticks, 5, "one timestamp per log event");
for (const [i, level] of ["log", "info", "warn", "error", "debug"].entries()) {
  assert.equal(writes[i].level, level);
  assert.equal(writes[i].args[0], "[2026-11-05T11:12:30.123Z]");
}
assert.deepEqual(writes[1].args.slice(1), ["[qoder-lite] info", { requestId: "r1" }]);
assert.deepEqual(writes[2].args.slice(1), ["[qoder-lite] upstream 403", "attempt 1/9"]);
assert.equal(writes[3].args[2], problem);
const fallbackLines = [];
createTimestampLogger({ log: (...args) => fallbackLines.push(args) }, () => 0).warn("fallback");
assert.deepEqual(fallbackLines[0], ["[1970-01-01T00:00:00.000Z]", "fallback"]);
console.log("✓ timestamps and original arguments preserved");
