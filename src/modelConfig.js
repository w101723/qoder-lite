const ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];
export function modelDetails(raw) {
  const t = raw?.thinking_config || {};
  const declared = t.enabled?.efforts || {};
  const levels = (Array.isArray(raw?.reasoning_efforts) ? raw.reasoning_efforts : Object.keys(declared)).map(String).filter((x) => ORDER.includes(x)).sort((a,b)=> ORDER.indexOf(a)-ORDER.indexOf(b));
  const defaultEffort = levels.find((x) => declared[x]?.is_default) || t.default_effort || t.defaultEffort || levels[0] || "";
  return { efforts: levels, defaultEffort, alwaysThinks: t.enabled != null && t.disabled == null, canDisable: t.disabled != null };
}
export function modelForRequest(raw, body = {}) {
  const d = modelDetails(raw);
  let asked = String(body.reasoning_effort ?? "").toLowerCase();
  const budget = body.max_completion_tokens ?? body.max_tokens ?? 0;
  if (!asked && budget > 0 && budget <= 1024) asked = "none";
  let thinking = (raw.thinking_config ? !!raw.thinking_config.enabled : !!raw.is_reasoning) && asked !== "none";
  if (d.alwaysThinks) thinking = true;
  const params = {};
  if (thinking) {
    if (d.efforts.length) {
      const index = ORDER.indexOf(asked);
      const match = d.efforts.includes(asked) ? asked : (index >= 0 ? [...d.efforts].sort((a, b) => Math.abs(ORDER.indexOf(a) - index) - Math.abs(ORDER.indexOf(b) - index) || ORDER.indexOf(b) - ORDER.indexOf(a))[0] : d.defaultEffort || d.efforts[0]);
      if (match) params.reasoning_effort = match;
    } else if (asked && asked !== "none") params.reasoning_effort = asked;
  }
  const cc = raw.context_config ?? raw.contextConfig ?? {};
  const values = Object.values(cc || {}).map((v) => Number(v?.token_count)).filter((v) => Number.isInteger(v) && v > 0);
  const fallback = raw.available_context_windows ?? raw.availableContextWindows ?? [];
  const list = [...new Set(values.length ? values : (Array.isArray(fallback) ? fallback : []).map(Number))].filter((v) => Number.isInteger(v) && v > 0).sort((a,b)=>a-b);
  const defaultWindow = Object.values(cc || {}).find((v) => v?.is_default === true || v?.is_default === 1 || v?.is_default === "1")?.token_count || raw.default_context_window || raw.max_input_tokens || 0;
  const needed = Math.ceil(Buffer.byteLength(JSON.stringify([body.messages || [], body.tools || []])) / 3) + Number(body.max_completion_tokens || body.max_tokens || 32768);
  if (list.length) params.context_length = Number(defaultWindow) >= needed ? Number(defaultWindow) : (list.find((v) => v >= needed) || list[list.length - 1]);
  const cfg = {
    key: raw.key, display_name: raw.display_name || raw.key,
    model: "", format: raw.format || "", is_vl: !!raw.is_vl,
    is_reasoning: thinking, api_key: "", url: "",
    source: raw.source || "system", max_input_tokens: raw.max_input_tokens || 180000,
  };
  return { config: cfg, parameters: { enable_thinking: thinking, ...params } };
}
