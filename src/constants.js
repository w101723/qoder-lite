/**
 * Qoder API constants — extracted from 9Router's open-sse/shared/qoder/constants.js
 * (originally ported from CLIProxyAPIPlus qoder-provider branch).
 *
 * Endpoint set:
 *   openapi.qoder.sh   - device flow + userinfo + quota usage + PAT exchange
 *   center.qoder.sh    - token refresh (best-effort, currently 403 for device tokens)
 *   api3.qoder.sh      - inference (chat) + model list, requires COSY signing
 *   api2.qoder.sh      - same as api3 but the only host that accepts job tokens (jt-...)
 *   qoder.com/device   - browser landing page for device authorization
 */

// The standalone service uses one Qoder region per process.
// SOURCE unset / INTL => international; SOURCE=CN => mainland China.
export const QODER_SOURCE = (process.env.SOURCE || "INTL").trim().toUpperCase() === "CN" ? "CN" : "INTL";
const REGION_BASES = {
  INTL: {
    openapi: "https://openapi.qoder.sh",
    center: "https://center.qoder.sh",
    chat: "https://api3.qoder.sh",
    chatAlt: "https://api2.qoder.sh", // job tokens must use api2
    login: "https://qoder.com/device/selectAccounts",
  },
  CN: {
    openapi: "https://openapi.qoder.com.cn",
    center: "https://gateway.qoder.com.cn",
    chat: "https://gateway.qoder.com.cn",
    chatAlt: "https://gateway.qoder.com.cn",
    login: "https://qoder.com.cn/device/selectAccounts",
  },
};
const upstream = REGION_BASES[QODER_SOURCE];
export const QODER_OPENAPI_BASE = upstream.openapi;
export const QODER_CENTER_BASE = upstream.center;
export const QODER_CHAT_BASE = upstream.chat;
export const QODER_CHAT_BASE_ALT = upstream.chatAlt;
export const QODER_LOGIN_URL = upstream.login;

// Device flow endpoints
export const QODER_DEVICE_TOKEN_URL = `${QODER_OPENAPI_BASE}/api/v1/deviceToken/poll`;
export const QODER_USERINFO_URL = `${QODER_OPENAPI_BASE}/api/v1/userinfo`;
export const QODER_QUOTA_USAGE_URL = `${QODER_OPENAPI_BASE}/api/v2/quota/usage`;
export const QODER_REFRESH_TOKEN_URL = `${QODER_CENTER_BASE}/algo/api/v3/user/refresh_token`;

// PAT (Personal Access Token, pt-...) → short-lived job token (jt-...) exchange.
// PATs cannot sign COSY requests directly — they must be exchanged first.
// This endpoint is NOT COSY-signed (plain JSON POST).
export const QODER_JOB_TOKEN_EXCHANGE_URL = `${QODER_OPENAPI_BASE}/api/v1/jobToken/exchange`;
export const QODER_JOB_TOKEN_REFRESH_URL = `${QODER_OPENAPI_BASE}/api/v1/jobToken/refresh`;

// Inference endpoints (under /algo on api3.qoder.sh, all COSY-signed)
export const QODER_CHAT_SIG_PATH = "/api/v2/service/pro/sse/agent_chat_generation";
export const QODER_CHAT_URL = `${QODER_CHAT_BASE}/algo${QODER_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common`;
export const QODER_CHAT_URL_ENCODED = `${QODER_CHAT_URL}&Encode=1`;
export const QODER_MODEL_LIST_URL = `${QODER_CHAT_BASE}/algo/api/v2/model/list`;
// Image upload shares the selected inference host and COSY signing.
export const QODER_IMAGE_UPLOAD_SIG_PATH = "/api/v2/image/upload";
export const QODER_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const QODER_INLINE_FALLBACK_MAX_BYTES = 512 * 1024;
export const QODER_MAX_PAYLOAD_BYTES = 6 * 1024 * 1024;

// COSY header constants. These are not arbitrary — the upstream signature
// validation matches them against the values used at signing time.
export const QODER_IDE_VERSION = "1.1.69";
export const QODER_CLIENT_TYPE = "10";
export const QODER_DATA_POLICY = "disagree";
export const QODER_LOGIN_VERSION = "v2";
export const QODER_MACHINE_OS = "x86_64_windows";
export const QODER_MACHINE_TYPE = "5";

// RSA public key for COSY encryption (extracted from Qoder IDE v0.9).
export const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
