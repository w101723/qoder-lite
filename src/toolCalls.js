import crypto from "node:crypto";
const idFor = (at, idx, c) => "call_" + crypto.createHash("sha256").update(JSON.stringify([at, idx, c?.function?.name, c?.function?.arguments])).digest("hex").slice(0, 32);
export function normalizeToolTurns(messages) {
  const out = [];
  let pending = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    if (m.role === "assistant" && m.tool_calls?.length) {
      const calls = m.tool_calls.map((c, j) => ({
        id: c.id || idFor(i, j, c), type: "function",
        function: { name: c.function?.name, arguments: typeof c.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c.function?.arguments || {}) },
      }));
      out.push({ ...m, tool_calls: calls });
      pending = calls.map((c) => c.id);
    } else if (m.role === "tool") {
      const images = Array.isArray(m.content) ? m.content.filter((p)=>p?.type === "image_url") : [];
      const content = images.length ? m.content.filter((p)=>p?.type === "text").map((p)=>p.text).join("\n") : m.content;
      const requested = pending.includes(m.tool_call_id) ? m.tool_call_id : pending[0];
      if (requested) {
        out.push({ ...m, content, tool_call_id: requested });
        if (images.length) out.push({role:"user",content:[{type:"text",text:"[Images returned by tool " + requested + "]"}, ...images]});
        pending = pending.filter((x) => x !== requested);
      } else out.push({ role: "user", content: typeof m.content === "string" ? m.content : JSON.stringify(m.content || "") });
    } else {
      if (m.role === "user") pending = [];
      out.push(m);
    }
  }
  return out;
}
