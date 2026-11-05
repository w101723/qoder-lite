/**
 * Upload-only regression checks. Queue/retry behavior stays in the original
 * smoke tests and is intentionally unaffected.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rewriteQoderMessageAttachments } from "../src/attachments.js";

const bytes = Buffer.from("test image bytes");
const dataUri = "data:image/png;base64," + bytes.toString("base64");
const credentials = {
  accessToken: "jt-test",
  providerSpecificData: { userId: "u-image", machineId: "m-image" },
};
const original = [{ role: "user", content: [
  { type: "text", text: "Describe" },
  { type: "image_url", image_url: { url: dataUri } },
  { type: "image_url", image_url: { url: dataUri } },
] }];
let attempts = 0;
const warnings = [];
const rewritten = await rewriteQoderMessageAttachments(original, {
  credentials,
  log: { warn: (line) => warnings.push(line) },
  fetchImpl: async () => {
    attempts++;
    return new Response(
      JSON.stringify({ code: 403, message: "Denied for pt-private-token Bearer jt-private-token" }),
      { status: 403 },
    );
  },
});
assert.equal(attempts, 1, "duplicate images inside one request should only upload once");
assert.equal(original[0].content[1].image_url.url, dataUri, "caller message is unchanged");
assert.equal(rewritten[0].content[1].image_url.url, dataUri);
assert.equal(rewritten[0].content[2].image_url.url, dataUri);
assert.equal(warnings.length, 1);
assert.match(warnings[0], /image upload HTTP 403/);
assert.match(warnings[0], /Denied for/);
assert.doesNotMatch(warnings[0], /pt-private-token|jt-private-token/);
console.log("✓ upload error body is redacted and small inline fallback is deduplicated");

const cnProbe = [
  'import { uploadQoderImage } from "./src/attachments.js";',
  'await uploadQoderImage({ bytes: Buffer.from("PNG"), mime: "image/png",',
  '  credentials: { accessToken: "jt-cn", providerSpecificData: { userId: "u-cn" } },',
  '  fetchImpl: async (url, init) => {',
  '    if (new URL(url).hostname !== "gateway.qoder.com.cn") throw Error("wrong CN host");',
  '    if (init.method !== "PUT" || init.headers["Cosy-Sigpath"] !== "/api/v2/image/upload") throw Error("wrong signed upload");',
  '    return new Response(JSON.stringify({ imageUrl: "https://oss.example/cn.png" }), { status: 200 });',
  '  } });',
  'console.log("CN_UPLOAD_OK");',
].join("\n");
const result = spawnSync(process.execPath, ["--input-type=module", "-e", cnProbe], {
  cwd: process.cwd(),
  env: { ...process.env, SOURCE: "CN" },
  encoding: "utf8",
});
assert.equal(result.status, 0, result.stderr);
assert.match(result.stdout, /CN_UPLOAD_OK/);
console.log("✓ CN image uploads use the region gateway");
