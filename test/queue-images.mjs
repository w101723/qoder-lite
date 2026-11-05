import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { QoderLiteClient, computeRetryDelayMs } from "../src/client.js";
import { deriveMachineId } from "../src/cosy.js";
import { rewriteQoderMessageAttachments } from "../src/attachments.js";

function imageData() {
  return "data:image/png;base64," + Buffer.from("image-bytes").toString("base64");
}
function upstreamFrame(status, body) {
  return "data: " + JSON.stringify({ statusCodeValue: status, body }) + "\n\n";
}
const creds = { accessToken: "dt-queue", providerSpecificData: { userId: "u-queue" } };
const expectedMachine = deriveMachineId("u-queue");
assert.equal(expectedMachine, deriveMachineId("u-queue"), "PAT machine identity must be stable");
assert.notEqual(expectedMachine, deriveMachineId("different"));
assert.match(expectedMachine, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);

assert.equal(computeRetryDelayMs({ isThrottle: true, retryAfterSeconds: 30 }, 1), 30000);
assert.equal(computeRetryDelayMs({ isThrottle: true, retryAfterSeconds: 100 }, 1), 60000);
assert.equal(computeRetryDelayMs({ isThrottle: true, retryAfterSeconds: 0 }, 1), 30000);
assert.equal(computeRetryDelayMs({ isThrottle: true, retryAfterSeconds: 30 }, 1, 1), 1);
console.log("✓ throttle delay respects 30s queue hint");

// Repeated small images must not trigger repeated HTTP 403 uploads, and the
// response text must be useful for diagnosis without leaking PAT/job tokens.
const data = imageData();
let forbiddenCalls = 0;
const warnings = [];
const fallback = await rewriteQoderMessageAttachments([{ role: "user", content: [
  { type: "image_url", image_url: { url: data } },
  { type: "image_url", image_url: { url: data } },
]}], {
  credentials: creds,
  log: { warn: (s) => warnings.push(s) },
  fetchImpl: async () => {
    forbiddenCalls++;
    return new Response(JSON.stringify({ code: 403, message: "Access denied for pt-secret Bearer jt-private123" }), { status: 403 });
  },
});
assert.equal(forbiddenCalls, 1);
assert.equal(fallback[0].content[0].image_url.url, data);
assert.equal(fallback[0].content[1].image_url.url, data);
assert.equal(warnings.length, 1);
assert.match(warnings[0], /image upload HTTP 403/);
assert.match(warnings[0], /Access denied/);
assert.doesNotMatch(warnings[0], /pt-secret|jt-private123/);
console.log("✓ upload 403 keeps redacted diagnostics and deduplicates fallback");

// Simulate a 10605 queued response followed by success. The image upload,
// dynamic model config and business request ID must be prepared only once,
// but each attempt must receive a fresh COSY signature.
let modelCalls = 0, uploadCalls = 0, chatCalls = 0;
const bodies = [], signatures = [], machines = [];
const fetchImpl = async (url, init) => {
  const address = String(url);
  if (address.includes("/model/list")) {
    modelCalls++;
    machines.push(init.headers["Cosy-Machineid"]);
    return new Response(JSON.stringify({ chat: [{ key: "auto", display_name: "Auto", is_vl: true }] }), { status: 200 });
  }
  if (address.includes("/image/upload")) {
    uploadCalls++;
    machines.push(init.headers["Cosy-Machineid"]);
    assert.equal(init.method, "PUT");
    return new Response(JSON.stringify({ imageUrl: "https://oss.example/one.png" }), { status: 200 });
  }
  if (address.includes("agent_chat_generation")) {
    chatCalls++;
    machines.push(init.headers["Cosy-Machineid"]);
    signatures.push(init.headers.Authorization);
    bodies.push(Buffer.from(init.body));
    if (chatCalls === 1) return new Response(upstreamFrame(403,
      JSON.stringify({ code: "10605", message: JSON.stringify({ isQueued: true, retryAfterSeconds: 30, subCode: "CALL_COUNT_LIMIT" }) })),
      { status: 200 });
    return new Response(upstreamFrame(200, JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }))
      + upstreamFrame(200, "[DONE]"), { status: 200 });
  }
  throw Error("unexpected fetch " + address);
};
const client = new QoderLiteClient(creds, { fetchImpl, log: { warn: () => {} } });
const result = await client.chat({
  model: "auto", messages: [{ role: "user", content: [
    { type: "text", text: "What is here?" },
    { type: "image_url", image_url: { url: data } },
  ] }],
}, { retryDelayMs: 1 });
assert.equal(result.status, 200);
assert.match(await result.text(), /ok/);
assert.equal(chatCalls, 2);
assert.equal(modelCalls, 1, "model config should not be re-fetched on retry");
assert.equal(uploadCalls, 1, "image upload should not repeat on chat retry");
assert.deepEqual(machines, Array(machines.length).fill(expectedMachine));
assert.deepEqual(bodies[0], bodies[1], "retry must reuse the same Qoder business request body");
assert.notEqual(signatures[0], signatures[1], "each retry must be COSY-signed afresh");
console.log("✓ 10605 retry reuses image payload, keeps request ID, signs afresh");

// CN must use its own gateway for PAT job-token image uploads as well.
const cnProbe = [
  'import { uploadQoderImage } from "./src/attachments.js";',
  'await uploadQoderImage({ bytes: Buffer.from("PNG"), mime: "image/png",',
  '  credentials: { accessToken: "jt-cn", providerSpecificData: { userId: "u-cn" } },',
  '  fetchImpl: async (url, init) => {',
  '    if (new URL(url).hostname !== "gateway.qoder.com.cn") throw Error("wrong CN image host");',
  '    if (init.method !== "PUT" || init.headers["Cosy-Sigpath"] !== "/api/v2/image/upload") throw Error("wrong signed upload request");',
  '    return new Response(JSON.stringify({ imageUrl: "https://oss.example/cn.png" }), { status: 200 });',
  '  } });',
  'console.log("CN_UPLOAD_OK");',
].join("\n");
const cnChild = spawnSync(process.execPath, ["--input-type=module", "-e", cnProbe], {
  cwd: process.cwd(), env: { ...process.env, SOURCE: "CN" }, encoding: "utf8",
});
assert.equal(cnChild.status, 0, cnChild.stderr);
assert.match(cnChild.stdout, /CN_UPLOAD_OK/);
console.log("✓ CN image PUT reaches gateway.qoder.com.cn with COSY signature");
