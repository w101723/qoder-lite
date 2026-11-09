import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initiateDeviceFlow, loginWithDeviceFlow, fetchUserInfo } from "./deviceFlow.js";
import { QODER_OPENAPI_BASE, QODER_SOURCE } from "./constants.js";

const CLIENT_IDS = {
  INTL: "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa",
  CN: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
};
const LEAD = 5 * 60_000;
const DEFAULT_TTL = 24 * 60 * 60_000;
const fingerprint = (v) => crypto.createHash("sha256").update(v).digest("hex");

export function jobExpiry(value, now = Date.now()) {
  for (const field of ["expire_time", "expires_at"]) {
    const valueAt = value?.[field];
    const n = Number(valueAt);
    const stamp = n > 0 ? (n < 1e12 ? n * 1000 : n) : Date.parse(String(valueAt ?? ""));
    if (Number.isFinite(stamp) && stamp > now) return stamp;
  }
  return Number(value?.expires_in) > 0 ? now + Number(value.expires_in) : now + DEFAULT_TTL;
}

export class CredentialManager {
  constructor({ pat = "", authFile, fetchImpl = fetch, log = console, loginImpl, region = QODER_SOURCE } = {}) {
    this.pat = pat;
    this.region = region;
    this.authFile = authFile || path.join(os.homedir(), ".qoder-lite", "auth.json");
    this.fetch = fetchImpl;
    this.log = log;
    this.loginImpl = loginImpl;
    this.state = null;
    this.pending = null;
  }

  async load() {
    try {
      const file = await fs.readFile(this.authFile, "utf8");
      const data = JSON.parse(file);
      const ident = this.pat ? fingerprint(this.pat) : "device";
      if (data.region === this.region && data.ident === ident && data.machineId && data.userId) {
        this.state = data;
      }
    } catch (e) {
      if (e.code !== "ENOENT") this.log.warn?.("[qoder-lite] cached login unavailable; a new login may be needed");
    }
  }

  async save() {
    await fs.mkdir(path.dirname(this.authFile), { recursive: true, mode: 0o700 });
    const temp = this.authFile + "." + process.pid + ".tmp";
    await fs.writeFile(temp, JSON.stringify(this.state), { mode: 0o600 });
    await fs.chmod(temp, 0o600);
    await fs.rename(temp, this.authFile);
  }

  async api(endpoint, { token, payload } = {}) {
    const res = await this.fetch(QODER_OPENAPI_BASE + endpoint, {
      method: payload ? "POST" : "GET",
      headers: { Accept: "application/json", ...(payload ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: "Bearer " + token } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error("Qoder auth HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    return data || {};
  }

  async initiate() {
    if (this.state === null) await this.load();
    if (!this.pat && !this.state) await this.login();
    return this.state;
  }

  async login() {
    if (this.pat) return this.exchange();
    const flow = initiateDeviceFlow();
    this.log.log?.("[qoder-lite] Login required. Open: " + flow.verificationUriComplete);
    const poll = this.loginImpl || loginWithDeviceFlow;
    const got = await poll(flow, { fetchImpl: this.fetch, totalTimeoutMs: 15 * 60_000 });
    const profile = await fetchUserInfo(got.accessToken, { fetchImpl: this.fetch });
    const userId = got.userId || profile.userId;
    if (!userId) throw new Error("Qoder login returned no user id");
    let chat;
    try {
      chat = await this.api("/api/v1/me/jobToken", {
        token: got.accessToken,
        payload: { clientId: CLIENT_IDS[this.region] },
      });
    } catch (e) {
      if (this.region !== "CN" || ![400, 401, 403, 404].includes(e.status)) throw e;
      chat = null; // CN CLI can use device tokens directly.
    }
    this.state = {
      region: this.region, ident: "device", userId, machineId: flow.machineId,
      email: profile.email || "", name: profile.name || "",
      accessToken: chat?.token || got.accessToken,
      refreshToken: chat?.refresh_token || got.refreshToken || "",
      deviceToken: got.accessToken, deviceRefresh: got.refreshToken || "",
      deviceChat: !chat,
      expiresAt: chat ? jobExpiry(chat) : (got.expireTime || Date.now() + DEFAULT_TTL),
    };
    await this.save();
    return this.state;
  }

  async exchange() {
    const data = await this.api("/api/v1/jobToken/exchange", { payload: { personal_token: this.pat } });
    if (!data.token) throw new Error("Qoder PAT exchange returned no job token");
    const profile = await this.api("/api/v1/userinfo", { token: data.token });
    const userId = String(profile.id || profile.user_id || profile.uid || this.state?.userId || "");
    if (!userId) throw new Error("Qoder PAT userinfo returned no user id");
    this.state = {
      region: this.region, ident: fingerprint(this.pat), userId,
      machineId: this.state?.machineId || crypto.randomUUID(),
      email: profile.email || "", name: profile.name || "",
      accessToken: data.token, refreshToken: data.refresh_token || "",
      deviceChat: false, expiresAt: jobExpiry(data),
    };
    await this.save();
    return this.state;
  }

  async renew() {
    if (!this.state) return this.pat ? this.exchange() : this.login();
    const s = this.state;
    if (!s.refreshToken) return this.pat ? this.exchange() : this.login();
    const endpoint = s.deviceChat ? "/api/v1/deviceToken/refresh" : "/api/v1/jobToken/refresh";
    try {
      const result = await this.api(endpoint, { payload: { refresh_token: s.refreshToken } });
      if (!result.token || !result.refresh_token) throw new Error("Qoder refresh returned incomplete token pair");
      this.state = {
        ...s, accessToken: result.token, refreshToken: result.refresh_token,
        ...(s.deviceChat ? { deviceToken: result.token, deviceRefresh: result.refresh_token } : {}),
        expiresAt: s.deviceChat ? Date.now() + DEFAULT_TTL : jobExpiry(result),
      };
      await this.save();
      return this.state;
    } catch (err) {
      if (this.pat && [400, 401, 403].includes(err.status)) return this.exchange();
      if (err.status === 401 || err.status === 403) {
        throw new Error("Qoder login expired; delete/replace saved login and sign in again");
      }
      throw err;
    }
  }

  async resolve({ forceRefresh = false } = {}) {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      if (this.state === null) await this.load();
      if (!this.state) await (this.pat ? this.exchange() : this.login());
      else if (forceRefresh || this.state.expiresAt - Date.now() <= LEAD) await this.renew();
      return {
        accessToken: this.state.accessToken,
        email: this.state.email, displayName: this.state.name,
        providerSpecificData: { userId: this.state.userId, machineId: this.state.machineId, deviceChat: this.state.deviceChat },
      };
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }
}
