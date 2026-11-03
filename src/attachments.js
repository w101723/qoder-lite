/** OpenAI image_url parts: COSY-signed image upload and message rewriting. */
import crypto from "node:crypto";
import { buildCosyHeaders } from "./cosy.js";
import { fetchWithTimeout } from "./http.js";
import { QODER_CHAT_BASE, QODER_CHAT_BASE_ALT, QODER_IMAGE_UPLOAD_SIG_PATH, QODER_MAX_IMAGE_BYTES, QODER_INLINE_FALLBACK_MAX_BYTES } from "./constants.js";

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp" };
const isHttp = (url) => /^https?:\/\/\S+$/i.test(url);
function parseDataUri(raw) {
  if (!raw.startsWith("data:")) return null;
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(raw);
  if (!match) throw new Error("qoder: malformed image data URI");
  const mime = match[1].toLowerCase();
  if (!EXT[mime]) throw new Error(`qoder: unsupported image type ${mime}`);
  const b64 = match[2].replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) throw new Error("qoder: malformed image base64");
  const size = b64.length * 3 / 4 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  if (!size) throw new Error("qoder: empty image");
  if (size > QODER_MAX_IMAGE_BYTES) throw new Error(`qoder: image exceeds ${QODER_MAX_IMAGE_BYTES} bytes`);
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length !== size) throw new Error("qoder: malformed image base64");
  return { bytes, mime };
}

export function uploadedImageUrl(json) {
  if (!json || typeof json !== "object") return null;
  const inner = json.result && typeof json.result === "object" ? json.result : json;
  for (const key of ["imageUrls", "image_urls"]) {
    const list = inner[key] || json[key];
    if (Array.isArray(list) && typeof list[0] === "string") return list[0];
  }
  for (const key of ["imageUrl", "image_url", "url", "ossUrl", "oss_url", "originalUrl", "originUrl", "link", "image"]) {
    const value = inner[key] || json[key];
    if (typeof value === "string") return value;
  }
  if (typeof json.body === "string") { try { return uploadedImageUrl(JSON.parse(json.body)); } catch {} }
  return null;
}

export async function uploadQoderImage({ bytes, mime, credentials, fetchImpl, signal }) {
  const psd = credentials.providerSpecificData || {};
  if (!psd.userId || !credentials.accessToken) throw new Error("qoder: missing upload credentials");
  const host = credentials.accessToken.startsWith("jt-") ? QODER_CHAT_BASE_ALT : QODER_CHAT_BASE;
  const url = `${host}/algo${QODER_IMAGE_UPLOAD_SIG_PATH}?request_id=${crypto.randomUUID()}`;
  const boundary = `----qoderLite${crypto.randomUUID().replace(/-/g, "")}`;
  const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.${EXT[mime]}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const body = Buffer.concat([header, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const headers = {
    ...buildCosyHeaders(body, url, { userId: psd.userId, authToken: credentials.accessToken, name: credentials.displayName || "", email: credentials.email || "", machineId: psd.machineId || "" }),
    Accept: "application/json",
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
    "Content-Length": String(body.length),
    "AI-CLIENT-TIMESTAMP": String(Math.floor(Date.now() / 1000)),
    "Accept-Encoding": "identity",
  };
  const response = await fetchWithTimeout(url, { method: "PUT", headers, body, signal }, 30000, fetchImpl);
  if (!response.ok) throw new Error(`qoder: image upload HTTP ${response.status}`);
  const uploaded = uploadedImageUrl(await response.json().catch(() => null));
  if (!uploaded || !isHttp(uploaded)) throw new Error("qoder: image upload response did not include an HTTP image URL");
  return uploaded;
}

async function rewriteImage(raw, ctx, uploads) {
  if (typeof raw !== "string" || !raw) throw new Error("qoder: missing image_url");
  if (isHttp(raw)) return { type: "image_url", image_url: { url: raw } };
  const data = parseDataUri(raw);
  if (!data) throw new Error("qoder: image_url must be HTTP(S) or base64 data URI");
  const digest = crypto.createHash("sha256").update(data.bytes).digest("hex");
  if (uploads.has(digest)) return { type: "image_url", image_url: { url: uploads.get(digest) } };
  let url;
  try { url = await (ctx.uploadFn || uploadQoderImage)({ ...data, credentials: ctx.credentials, fetchImpl: ctx.fetchImpl, signal: ctx.signal }); }
  catch (err) {
    if (data.bytes.length <= QODER_INLINE_FALLBACK_MAX_BYTES) {
      ctx.log?.warn?.(`[qoder-lite] image upload failed; falling back to inline URI: ${err.message}`);
      return { type: "image_url", image_url: { url: raw } };
    }
    throw new Error(`qoder: image upload failed; image not sent: ${err.message}`);
  }
  if (!isHttp(url)) throw new Error("qoder: image uploader returned invalid URL");
  uploads.set(digest, url);
  return { type: "image_url", image_url: { url } };
}

/** Clone incoming messages; maintain interleaved text/image order. */
export async function rewriteQoderMessageAttachments(messages, ctx = {}) {
  if (!Array.isArray(messages)) throw new Error("qoder: messages must be an array");
  const uploads = new Map();
  const out = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const copy = { ...message };
    let parts = message.content;
    if (Array.isArray(message.images) && message.images.length) {
      parts = Array.isArray(parts) ? [...parts] : [{ type: "text", text: typeof parts === "string" ? parts : "" }];
      parts.push(...message.images.map((url) => ({ type: "image_url", image_url: { url } })));
      delete copy.images;
    }
    if (Array.isArray(parts)) {
      const next = [];
      for (const part of parts) {
        if (!part || typeof part !== "object") throw new Error("qoder: invalid multipart block");
        if (part.type === "text" && typeof part.text === "string") next.push({ type: "text", text: part.text });
        else if (part.type === "image_url") next.push(await rewriteImage(typeof part.image_url === "string" ? part.image_url : part.image_url?.url, ctx, uploads));
        else if (part.type === "image" && part.source?.type === "url") next.push(await rewriteImage(part.source.url, ctx, uploads));
        else if (part.type === "image" && part.source?.type === "base64") next.push(await rewriteImage(`data:${part.source.media_type || "image/png"};base64,${part.source.data}`, ctx, uploads));
        else if (part.type === "file" || part.type === "document") throw new Error("qoder: document input is not supported");
        else throw new Error(`qoder: unsupported multipart block ${part.type || "unknown"}`);
      }
      copy.content = next;
    } else copy.content = parts;
    out.push(copy);
  }
  return out;
}
