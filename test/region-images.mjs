import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { rewriteQoderMessageAttachments } from "../src/attachments.js";
import { normalizeMessages } from "../src/chat.js";

const script = [
  "import { QODER_SOURCE, QODER_OPENAPI_BASE, QODER_CHAT_BASE, QODER_CHAT_BASE_ALT, QODER_QUOTA_USAGE_URL, QODER_JOB_TOKEN_EXCHANGE_URL } from './src/constants.js';",
  "import { buildChatUrl } from './src/chat.js';",
  "console.log(JSON.stringify({source:QODER_SOURCE,openapi:QODER_OPENAPI_BASE,chat:QODER_CHAT_BASE,alt:QODER_CHAT_BASE_ALT,quota:QODER_QUOTA_USAGE_URL,pat:QODER_JOB_TOKEN_EXCHANGE_URL,job:buildChatUrl({accessToken:'jt-1'}),device:buildChatUrl({accessToken:'dt-1'})}));",
].join("\n");
for (const [source, openapi, deviceHost, jobHost] of [
  ["INTL","openapi.qoder.sh","api3.qoder.sh","api2.qoder.sh"],
  ["CN","openapi.qoder.com.cn","gateway.qoder.com.cn","gateway.qoder.com.cn"],
]) {
  const run = spawnSync(process.execPath, ["--input-type=module","-e",script], { cwd:process.cwd(), env:{ ...process.env,SOURCE:source }, encoding:"utf8" });
  assert.equal(run.status, 0, run.stderr);
  const data = JSON.parse(run.stdout.trim());
  assert.equal(data.source, source);
  assert.equal(new URL(data.openapi).hostname, openapi);
  for (const key of ["quota","pat"]) assert.equal(new URL(data[key]).hostname, openapi);
  for (const key of ["chat","device"]) assert.equal(new URL(data[key]).hostname, deviceHost);
  for (const key of ["alt","job"]) assert.equal(new URL(data[key]).hostname, jobHost);
}
console.log("✓ INTL and CN upstream routes");

const bytes = Buffer.from("test-image-bytes");
const dataUri = `data:image/png;base64,${bytes.toString("base64")}`;
const original = [{role:"user",content:[
  {type:"text",text:"Look here"},
  {type:"image_url",image_url:{url:dataUri}},
  {type:"image_url",image_url:{url:dataUri}},
  {type:"text",text:"and here"},
  {type:"image_url",image_url:{url:"https://example.com/a.png"}},
]}];
const creds = {accessToken:"jt-test",providerSpecificData:{userId:"user-1",machineId:"machine-1"}};
let uploads = 0;
const fetchImpl = async (url, init) => {
  uploads++;
  assert.match(String(url), /api2\.qoder\.sh\/algo\/api\/v2\/image\/upload\?request_id=/);
  assert.equal(init.method, "PUT");
  assert.ok(init.headers.Authorization.startsWith("Bearer COSY."));
  assert.equal(init.headers["Cosy-Sigpath"], "/api/v2/image/upload");
  // Unlike chat, the official Qoder image uploader signs the *decimal body
  // length string*, while transmitting actual multipart bytes.
  const signatureBody = Buffer.from(String(init.body.length));
  assert.equal(init.headers["Cosy-Bodylength"], String(signatureBody.length));
  assert.equal(init.headers["Cosy-Bodyhash"], crypto.createHash("md5").update(signatureBody).digest("hex"));
  const match = /^Bearer COSY\.([^.]*)\.([0-9a-f]{32})$/.exec(init.headers.Authorization);
  assert.ok(match, "COSY Authorization must have a payload and MD5 signature");
  const sigInput = [match[1], init.headers["Cosy-Key"], init.headers["Cosy-Date"], String(init.body.length), "/api/v2/image/upload"].join("\n");
  const expectedSig = crypto.createHash("md5").update(Buffer.from(sigInput, "latin1")).digest("hex");
  assert.equal(match[2], expectedSig, "signed payload must be the decimal multipart byte count");
  const requestId = new URL(url).searchParams.get("request_id");
  assert.match(requestId, /^[a-f0-9]{32}$/, "request_id is a hyphen-free UUID");
  const boundary = init.headers["Content-Type"].split("boundary=")[1];
  assert.match(boundary, /^----qodercli-[a-f0-9]{32}$/, "use native qodercli multipart boundary");
  assert.ok(init.body.includes(bytes));
  return new Response(JSON.stringify({result:{imageUrls:["https://oss.example/image.png"]}}),{status:200});
};
const rewritten = await rewriteQoderMessageAttachments(original,{credentials:creds,fetchImpl});
assert.equal(uploads,1,"deduplicate repeated image data within request");
assert.equal(original[0].content[1].image_url.url,dataUri,"no mutation of caller data");
assert.deepEqual(rewritten[0].content.map(p=>p.text||p.image_url?.url),[
  "Look here","https://oss.example/image.png","https://oss.example/image.png","and here","https://example.com/a.png"
]);
assert.deepEqual(normalizeMessages(rewritten).messages[0].content,rewritten[0].content);
await assert.rejects(()=>rewriteQoderMessageAttachments([{role:"user",content:[{type:"image_url",image_url:{url:"file:///etc/passwd"}}]}],{credentials:creds}),/HTTP\(S\)/);
await assert.rejects(()=>rewriteQoderMessageAttachments([{role:"user",content:[{type:"image_url",image_url:{url:"data:image/png;base64,@@@"}}]}],{credentials:creds}),/malformed/);
await assert.rejects(()=>rewriteQoderMessageAttachments([{role:"user",content:[{type:"image_url",image_url:{url:`data:image/png;base64,${Buffer.alloc(600000,1).toString("base64")}`}}]}],{credentials:creds,uploadFn:async()=>{throw Error("offline")}}),/image not sent/);
console.log("✓ signed upload, dedupe, multipart, validation, and error behavior");
