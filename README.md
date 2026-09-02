# qoder-lite

Qoder 的 OpenAI-compatible HTTP 服务。

## 启动参数

| 环境变量 | 必填 | 默认值 | 说明 |
|---|---:|---|---|
| `QODER_PAT` | 是 | — | Qoder PAT，必须以 `pt-` 开头 |
| `API_KEY` | 是 | — | 调用本服务 API 时使用的 Bearer Key |
| `HOST` | 否 | `0.0.0.0` | 服务监听地址 |
| `PORT` | 否 | `3000` | 服务监听端口，范围 `1-65535` |

Docker 镜像：

```text
ghcr.io/w101723/qoder-lite:latest
```

支持 `linux/amd64` 和 `linux/arm64`。

```bash
export QODER_PAT="pt-你的token"
export API_KEY="$(openssl rand -hex 32)"

docker pull ghcr.io/w101723/qoder-lite:latest

docker run -d \
  --name qoder-lite \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -e QODER_PAT \
  -e API_KEY \
  ghcr.io/w101723/qoder-lite:latest
```

检查服务：

```bash
curl http://127.0.0.1:3000/health
```

查看日志：

```bash
docker logs -f qoder-lite
```

停止并删除容器：

```bash
docker rm -f qoder-lite
```

API Base URL：

```text
http://127.0.0.1:3000/v1
```

除 `/health` 外，所有接口都必须携带：

```http
Authorization: Bearer <API_KEY>
```

客户端使用的是服务端配置的 `API_KEY`，不要把 `QODER_PAT` 放入请求头。

## 对外 API

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---:|---|
| `GET` | `/health` | 否 | 服务健康检查 |
| `GET` | `/v1/models` | 是 | 获取 Qoder 模型列表及上游 `display_name` 对应的 `dmodel` |
| `POST` | `/v1/chat/completions` | 是 | OpenAI-compatible Chat Completions，支持流式与非流式 |
| `GET` | `/v1/dashboard/billing/subscription` | 是 | 用户总 credits，使用 Dashboard Billing 订阅格式 |
| `GET` | `/v1/dashboard/billing/usage` | 是 | 用户已用 credits 原始值，不乘以 `100` |
| `GET` | `/v1/dashboard/billing/credit_grants` | 是 | 可用 credits 原始值，即 `user.total - user.used` |
| `GET` | `/v1/qoder/usage` | 是 | 完整的 Qoder 用户及组织额度信息 |

### 健康检查

```http
GET /health
```

无需鉴权，无请求参数。

```json
{
  "status": "ok"
}
```

### 模型列表

```http
GET /v1/models
Authorization: Bearer <API_KEY>
```

无请求参数。

```json
{
  "object": "list",
  "data": [
    {
      "id": "auto",
      "object": "model",
      "created": 0,
      "owned_by": "qoder",
      "dmodel": "DeepSeek-V4-Pro"
    }
  ]
}
```

Chat 的 `model` 可以使用模型列表返回的裸模型名，例如 `auto`，也可以使用 `qoder/auto`。

### Chat Completions

```http
POST /v1/chat/completions
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

请求体最大为 1 MiB。

#### 请求参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `model` | string | 是 | — | 模型 ID，例如 `auto` 或 `qoder/auto` |
| `messages` | array | 是 | — | OpenAI 格式的消息列表 |
| `stream` | boolean | 否 | `false` | `true` 返回 SSE 流，`false` 返回完整 JSON |
| `max_tokens` | number | 否 | 模型上限 | 最大输出 token 数 |
| `max_completion_tokens` | number | 否 | 模型上限 | 最大生成 token 数；与 `max_tokens`、模型上限取最小值 |
| `tools` | array | 否 | `[]` | OpenAI function tool 定义 |

`messages` 中的元素：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `role` | string | 是 | `system`、`user`、`assistant` 或 `tool` |
| `content` | string | 是 | 消息文本；multipart content 只提取文本部分 |
| `tool_calls` | array | 否 | assistant 发起的工具调用 |
| `tool_call_id` | string | 否 | tool 消息对应的工具调用 ID |

当前未完整支持的参数（传入后可能被忽略）：

- `tool_choice`
- 图片及其他多模态输入
- `temperature`
- `top_p`
- `n`
- `stop`
- `response_format`
- `logprobs`

#### 非流式请求

```json
{
  "model": "auto",
  "messages": [
    {
      "role": "user",
      "content": "你好"
    }
  ]
}
```

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"你好"}]}'
```

#### 流式请求

```json
{
  "model": "auto",
  "stream": true,
  "messages": [
    {
      "role": "user",
      "content": "你好"
    }
  ]
}
```

```bash
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"你好"}]}'
```

流式响应以以下终止帧结束：

```text
data: [DONE]
```

### new-api 订阅额度

```http
GET /v1/dashboard/billing/subscription
Authorization: Bearer <API_KEY>
```

无请求参数。

```json
{
  "object": "billing_subscription",
  "has_payment_method": true,
  "soft_limit_usd": 1000,
  "hard_limit_usd": 1000,
  "system_hard_limit_usd": 1000,
  "access_until": 0
}
```

`soft_limit_usd`、`hard_limit_usd` 和 `system_hard_limit_usd` 的数值是 Qoder credits，不是真实美元。

### new-api 已用额度

```http
GET /v1/dashboard/billing/usage
Authorization: Bearer <API_KEY>
```

#### Query 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `start_date` | string | 否 | 格式 `YYYY-MM-DD`；为兼容 new-api 接受，但不参与计算 |
| `end_date` | string | 否 | 格式 `YYYY-MM-DD`；为兼容 new-api 接受，但不参与计算 |

```bash
curl "http://127.0.0.1:3000/v1/dashboard/billing/usage?start_date=2026-09-01&end_date=2026-09-01" \
  -H "Authorization: Bearer $API_KEY"
```

```json
{
  "object": "list",
  "total_usage": 300
}
```

计算规则：

```text
total_usage = Qoder 用户已用 credits 原始值
```

### 可用额度

```http
GET /v1/dashboard/billing/credit_grants
Authorization: Bearer <API_KEY>
```

无请求参数。`total_available` 为 Qoder 用户总 credits 减去已用 credits 的原始值，不做倍数转换或取整。

```json
{
  "object": "credit_summary",
  "total_available": 2873
}
```

计算规则：

```text
total_available = Qoder user.total - Qoder user.used
```

### Qoder 原生额度

```http
GET /v1/qoder/usage
Authorization: Bearer <API_KEY>
```

无请求参数。

```json
{
  "user": {
    "total": 1000,
    "used": 300,
    "remaining": 700,
    "unit": "credits"
  },
  "organization": {
    "total": 50000,
    "used": 50000,
    "remaining": 0,
    "unit": "credits"
  },
  "totalUsagePercentage": 30,
  "isQuotaExceeded": false,
  "expiresAt": 1781594470000,
  "resetAt": "2026-06-16T07:21:10.000Z"
}
```
