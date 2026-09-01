/**
 * qoder-lite 使用示例：PAT 登录 → 拉取模型 → 流式聊天。
 *
 * 运行（在仓库根目录或 qoder-lite/ 下）：
 *   QODER_PAT=pt-你的token node examples/pat-chat.mjs
 *   QODER_PAT=pt-xxx node examples/pat-chat.mjs "帮我写一个快速排序"
 *
 * 注意：这会发起真实网络请求，消耗 Qoder 配额。
 */

import { QoderLiteClient } from "../index.js";

const pat = process.env.QODER_PAT;
if (!pat || !pat.startsWith("pt-")) {
  console.error("请先设置环境变量 QODER_PAT（从 https://qoder.com/account/integrations 获取，pt- 前缀）");
  process.exit(1);
}

const prompt = process.argv[2] || "用一句话介绍你自己";
const model = process.env.QODER_MODEL || "auto";

const client = new QoderLiteClient({ apiKey: pat });

// 1. 拉取实时模型目录（COSY 签名，结果缓存 1 小时）
const catalog = await client.listModels();
if (!catalog) {
  console.error("模型目录拉取失败：请检查 PAT 是否有效、网络是否可达");
  process.exit(1);
}
console.log("可用模型:", catalog.models.map((m) => `${m.id} (${m.name})`).join(", "));

// 2. 查询配额用量（PAT 自动换 job token）
try {
  const usage = await client.getUsage();
  console.log(`额度: 用户 ${usage.user.used}/${usage.user.total} ${usage.user.unit}` +
    ` · 组织 ${usage.organization.used}/${usage.organization.total}` +
    ` · 总体 ${usage.totalUsagePercentage}%` +
    (usage.resetAt ? ` · 重置于 ${usage.resetAt}` : ""));
} catch (err) {
  console.error(`额度查询失败: ${err.message}`);
}

// 3. 流式聊天
console.log(`\n[${model}] ${prompt}\n`);
const response = await client.chat({
  model,
  messages: [
    { role: "system", content: "你是一个简洁的编程助手。" },
    { role: "user", content: prompt },
  ],
});

if (!response.ok) {
  console.error(`聊天请求失败: HTTP ${response.status}`);
  process.exit(1);
}

// response.body 是解包后的标准 OpenAI SSE 流
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      console.log("\n\n[完成]");
      process.exit(0);
    }
    try {
      const chunk = JSON.parse(data);
      process.stdout.write(chunk.choices?.[0]?.delta?.content ?? "");
    } catch { /* 跳过坏帧 */ }
  }
}
