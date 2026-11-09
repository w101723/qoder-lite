const ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];
export function modelDetails(raw) {
  const t = raw?.thinking_config || {};
  const levels = (t.supported_effort_levels || t.supportedEffortLevels || t.effort_levels || []).map(String).filter((x) => ORDER.includes(x));
  return { efforts: levels, defaultEffort: t.default_effort || t.defaultEffort || "", alwaysThinks: !!(t.always_enabled || t.alwaysEnabled) };
}
export function modelForRequest(raw, body = {}) {
  const d = modelDetails(raw);
  let asked = String(body.reasoning_effort ?? "").toLowerCase();
  const budget = body.max_completion_tokens ?? body.max_tokens ?? 0;
  if (!asked && budget > 0 && budget <= 1024) asked = "none";
  let thinking = !!raw.is_reasoning && asked !== "none";
  if (d.alwaysThinks) thinking = !!raw.is_reasoning;
  const params = {};
  if (thinking) {
    if (d.efforts.length) {
      const index = ORDER.indexOf(asked);
      const match = d.efforts.includes(asked) ? asked : (index >= 0 ? [...d.efforts].sort((a, b) => Math.abs(ORDER.indexOf(a) - index) - Math.abs(ORDER.indexOf(b) - index) || ORDER.indexOf(b) - ORDER.indexOf(a))[0] : d.defaultEffort || d.efforts[0]);
      if (match) params.reasoning_effort = match;
    } else if (asked && asked !== "none") params.reasoning_effort = asked;
  }
  const cfg = {
    key: raw.key, display_name: raw.display_name || raw.key,
    model: "", format: raw.format || "", is_vl: !!raw.is_vl,
    is_reasoning: thinking, api_key: "", url: "",
    source: raw.source || "system", max_input_tokens: raw.max_input_tokens || 180000,
  };
  return { config: cfg, parameters: { enable_thinking: thinking, ...params } };
}
