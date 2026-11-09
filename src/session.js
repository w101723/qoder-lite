import crypto from "node:crypto";

const digest = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const memory = new Map();
const MAX = 512, IDLE = 2 * 60 * 60_000;
export function sessionFor(body, accountId = "") {
  const headers = body._session || body.session_id || body.prompt_cache_key || body.user;
  const first = body.messages?.find((m) => m.role === "user");
  const system = body.messages?.filter((m) => ["system", "developer"].includes(m.role)).map((m) => m.content);
  const seed = headers ? ["named", headers, accountId] : ["conversation", system, first?.content, accountId];
  const h = digest(JSON.stringify(seed));
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join("-");
}
export function taskFor(session, messages, now = Date.now()) {
  for (const [k, v] of memory) if (now - v.used > IDLE) memory.delete(k);
  const at = messages.findLastIndex((m) => m?.role === "user");
  const user = at < 0 ? null : messages[at];
  const key = digest(JSON.stringify([session, at, user?.content]));
  let task = memory.get(key);
  if (!task) task = { id: crypto.randomUUID(), begin: now, answered: false };
  task.used = now;
  memory.delete(key); memory.set(key, task);
  while (memory.size > MAX) memory.delete(memory.keys().next().value);
  return task;
}
export function markAnswered(task) { if (task) task.answered = true; }
