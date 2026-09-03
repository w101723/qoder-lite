// qoder-lite — standalone Qoder client extracted from 9Router.
//
// Public API:
//   QoderLiteClient          — high-level client (auth + models + chat)
//   pat.js                   — PAT (pt-...) → job token (jt-...) exchange + caching
//   deviceFlow.js            — device-flow OAuth (PKCE + nonce + poll)
//   models.js                — COSY-signed live model catalog fetch + cache
//   usage.js                 — quota usage fetch (PAT auto-exchanged)
//   chat.js                  — request-body build, encode+sign, SSE unwrap
//   cosy.js / encoding.js    — COSY signing headers / WAF-bypass body encoding
//   constants.js             — upstream endpoints + COSY constants

export { QoderLiteClient, QoderBillingError, clearCatalogCache } from "./src/client.js";

export {
  isQoderPat,
  isQoderJobToken,
  exchangeJobToken,
  resolvePatCredential,
  resolveQoderCredentials,
  fetchUserIdForJobToken,
  clearPatJobCache,
} from "./src/pat.js";

export {
  generatePkcePair,
  initiateDeviceFlow,
  pollDeviceToken,
  loginWithDeviceFlow,
  fetchUserInfo,
  parseExpiry,
} from "./src/deviceFlow.js";

export {
  resolveQoderModels,
  getQoderModelConfig,
  invalidateCatalog,
  fetchQoderCatalogRaw,
} from "./src/models.js";

export {
  buildChatUrl,
  buildQoderRequestBody,
  sendQoderChatRequest,
  unwrapQoderSSEResponse,
  normalizeMessages,
  isBillingBlock,
  isThrottleBlock,
  extractRetryAfterSeconds,
  QoderUpstreamStatusError,
} from "./src/chat.js";

export { buildCosyHeaders, generateMachineId } from "./src/cosy.js";
export { getQoderUsage, resolveAndFetchUsage } from "./src/usage.js";
export { qoderEncodeBody } from "./src/encoding.js";
export * from "./src/constants.js";
