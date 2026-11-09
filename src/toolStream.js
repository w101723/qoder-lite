import crypto from "node:crypto";

/**
 * Incrementally promote Qoder's text-encoded tools to OpenAI tool_calls.
 * Works with <tool_call>{JSON}</tool_call>, <function=name> and
 * Anthropic-style <invoke name="name">. No parsing when tools are absent.
 */
const MARKERS = ["<tool_call>", "<function=", "<invoke name=", "<antml:invoke name=", "<function_calls>", "<antml:function_calls>"];
const ENDINGS = {
  "<tool_call>": "</tool_call>",
  "<function=": "</function>",
  "<invoke name=": "</invoke>",
  "<antml:invoke name=": "</antml:invoke>",
  "<function_calls>": "</function_calls>",
  "<antml:function_calls>": "</antml:function_calls>",
};
const MAX_CAPTURE = 256 * 1024;
const callID = () => "call_" + crypto.randomUUID().replaceAll("-", "");
const asText = (text) => ({ kind: "text", text });
function quoted(text) {
  const fences = text.match(/```/g)?.length || 0;
  if (fences % 2) return true;
  return (text.split("\n").at(-1).replace(/```/g, "").match(/`/g)?.length || 0) % 2 === 1;
}
function argsFor(xml, tool) {
  const props = tool.function?.parameters?.properties || {};
  const args = {};
  const param = /<parameter(?:\s+name\s*=\s*"([^"]+)"|=([^\s>]+))\s*>([\s\S]*?)<\/parameter>|<antml:parameter\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/antml:parameter>/g;
  for (const m of xml.matchAll(param)) {
    const name = m[1] || m[2] || m[4];
    const raw = (m[3] || m[5] || "").trim();
    if (!name) continue;
    if (props[name]?.type === "string") args[name] = raw;
    else { try { args[name] = JSON.parse(raw); } catch { args[name] = raw; } }
  }
  return args;
}
function parsed(segment, tools) {
  let calls = [];
  if (segment.startsWith("<tool_call>")) {
    const inside = segment.slice("<tool_call>".length, -"</tool_call>".length).trim();
    try {
      const obj = JSON.parse(inside);
      if (obj.name) calls.push({ name: obj.name, args: obj.arguments || obj.parameters || {} });
    } catch {}
    if (!calls.length) {
      const match = inside.match(/<function=([^\s>]+)>([\s\S]*?)<\/function>/);
      if (match) calls.push({ name: match[1], args: argsFor(match[2], tools.find((t) => t.function?.name === match[1]) || {}) });
    }
  } else if (segment.startsWith("<function=")) {
    const match = segment.match(/^<function=([^\s>]+)>([\s\S]*?)<\/function>$/);
    if (match) calls = [{ name: match[1], args: argsFor(match[2], tools.find((t) => t.function?.name === match[1]) || {}) }];
  } else {
    const re = /<(?:antml:)?invoke\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?invoke>/g;
    for (const m of segment.matchAll(re)) calls.push({ name: m[1], args: argsFor(m[2], tools.find((t) => t.function?.name === m[1]) || {}) });
  }
  if (!calls.length || calls.some((c) => !tools.some((t) => t.function?.name === c.name))) return [asText(segment)];
  return calls.map((c) => ({ kind: "call", name: c.name, args: JSON.stringify(c.args) }));
}
export class ToolStreamParser {
  constructor(tools = []) {
    this.tools = tools.filter((t) => t?.type === "function" && t.function?.name);
    this.buffer = "";
    this.mark = "";
    this.history = "";
    this.calls = 0;
  }
  feed(value, finish = false) {
    if (!this.tools.length) return value ? [asText(value)] : [];
    this.buffer += value || "";
    const output = [];
    const write = (text) => {
      if (!text) return;
      output.push(asText(text));
      this.history = (this.history + text).slice(-4096);
    };
    for (;;) {
      if (this.mark) {
        const close = ENDINGS[this.mark];
        const at = this.buffer.indexOf(close);
        if (at < 0) {
          if (this.buffer.length > MAX_CAPTURE || finish) {
            // Never silently forward an incomplete tool invocation.
            const err = new Error("Qoder emitted an incomplete tool call");
            err.code = "qoder_tool_parse_error";
            throw err;
          }
          break;
        }
        const whole = this.buffer.slice(0, at + close.length);
        const full = this.mark + whole;
        this.buffer = this.buffer.slice(at + close.length);
        this.mark = "";
        const items = parsed(full, this.tools);
        for (const item of items) {
          if (item.kind === "call") this.calls++;
          else this.history = (this.history + item.text).slice(-4096);
          output.push(item);
        }
        continue;
      }
      let at = -1, marker = "";
      for (const m of MARKERS) {
        const i = this.buffer.indexOf(m);
        if (i >= 0 && (at < 0 || i < at)) { at = i; marker = m; }
      }
      if (at >= 0) {
        const before = this.buffer.slice(0, at);
        if (quoted(this.history + before)) {
          write(this.buffer.slice(0, at + marker.length));
          this.buffer = this.buffer.slice(at + marker.length);
          continue;
        }
        write(before);
        this.buffer = this.buffer.slice(at + marker.length);
        this.mark = marker;
        continue;
      }
      if (finish) { write(this.buffer); this.buffer = ""; break; }
      // Retain only a suffix that might become an opener in the next chunk.
      let hold = 0;
      for (const m of MARKERS) for (let n = 1; n < m.length; n++) if (this.buffer.endsWith(m.slice(0, n))) hold = Math.max(hold, n);
      const keep = this.buffer.slice(this.buffer.length - hold);
      write(this.buffer.slice(0, this.buffer.length - hold));
      this.buffer = keep;
      break;
    }
    return output;
  }
  newCall(piece, index) {
    return { index, id: callID(), type: "function", function: { name: piece.name, arguments: piece.args } };
  }
}
