# 🔌 API 参考

Base URL：`http://127.0.0.1:10000`。配置了 `API_KEY` 时，`/v1/*` 请求需携带 `Authorization: Bearer <API_KEY>`。

## 📡 端点

| 方法 | 路径 | 说明 |
|:-----|:-----|:-----|
| `GET` | `/health` | 健康检查 |
| `GET` | `/health/details` | 结构化诊断（开关/鉴权可配置） |
| `GET` | `/metrics` | Prometheus 指标（开关/鉴权可配置） |
| `GET` | `/v1/models` | 模型列表（runtime 不可用时改由上游公开目录提供） |
| `POST` | `/v1/chat/completions` | Chat Completions |
| `POST` | `/v1/responses` | Responses API |

## 🧭 请求头

| 请求头 | 作用 |
|:--|:--|
| `Authorization` | `Bearer <API_KEY>`，配置了 `API_KEY` 时必填 |
| `x-opencode-session` / `x-session-id` / `x-thread-id` / `x-conversation-id` / `x-deepseek-harness-session-id` / `session-id` / `session_id` / `thread-id` / `thread_id` / `conversation-id` / `conversation_id` | **会话身份**：同一个值代表同一段对话，中间件据此复用上游会话（只有新增轮次会发给上游）。按上表顺序取第一个非空值（`x-opencode-session` 最优先：它是运维在网关侧显式配置的身份，不应被客户端可能带上的 `session-id` 顶掉）；名单可用 `OPENCODE_PROXY_SESSION_HEADERS` 收窄或重排 |
| `X-Forwarded-For` | 推导会话身份（`SESSION_DERIVE_ENABLED=true`）时参与隔离作用域 |

不带任何会话头时，行为回到"每个请求一个会话"（如需自动复用，见[配置详解](./configuration.md)的推导模式）。

## ⬆️ 上游选择

中间件按模型自动决定请求发往哪里，客户端无需关心：

| 模型 | 上游 | 说明 |
|:--|:--|:--|
| `opencode-go/*` | 直连 `https://opencode.ai/zen/go/v1` | Go 订阅额度，请求/响应体原样转发 |
| 付费 `opencode/*` | 直连 `https://opencode.ai/zen/v1` | 按量 Zen 额度 |
| `opencode/*-free`（及学习到的免费档模型） | 本地 runtime | 免费档闸门无法用请求头绕过 |

直连模式下上游的错误码与响应体**原样回传**（例如 `401 Invalid API key.`、`403 FreeTierError`、限流等）；只有 `model` 字段会被改回客户端请求的模型名。直连被拒或网络失败时会回退 runtime（`OPENCODE_PROXY_DIRECT_FALLBACK=false` 可关闭）。

### GET /v1/models

```json
{
  "object": "list",
  "data": [
    {
      "id": "opencode/big-pickle",
      "object": "model",
      "created": 1704067200,
      "owned_by": "opencode"
    }
  ]
}
```

## 💬 Chat Completions

```http
POST /v1/chat/completions
```

| 参数 | 类型 | 必填 | 说明 |
|:-----|:-----|:-----|:-----|
| `model` | string | ✅ | 模型 ID |
| `messages` | array | ✅ | 消息数组 |
| `tools` | array | - | 外部工具定义，OpenAI 兼容 function tools 结构 |
| `tool_choice` | string/object | - | 工具选择策略，按代理桥接语义处理 |
| `stream` | boolean | - | 是否流式输出 |
| `temperature` | number | - | 温度 (0-2) |
| `top_p` | number | - | 核采样 (0-1) |
| `max_tokens` | number | - | 最大 token 数 |
| `reasoning_effort` | string | - | 推理强度 |

```bash
curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "messages": [{"role": "user", "content": "你好!"}],
    "stream": false
  }'
```

## 🧠 Responses API

```http
POST /v1/responses
```

| 参数 | 类型 | 必填 | 说明 |
|:-----|:-----|:-----|:-----|
| `model` | string | ✅ | 模型 ID |
| `input` / `prompt` / `messages` | string/array | ✅* | 至少提供其中之一 |
| `previous_response_id` | string | - | 上一次响应的 ID，用于继续会话 |
| `tools` | array | - | 外部工具定义 |
| `stream` | boolean | - | 是否流式输出 |
| `reasoning_effort` | string | - | 推理强度 |

> \* `input`、`prompt`、`messages` 至少提供其一。

```bash
curl -N -X POST http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt5-nano",
    "input": "用一句话打招呼",
    "reasoning": {"effort": "high"},
    "stream": true
  }'
```

### 会话续接（previous_response_id）

把上一次响应返回的 ID 作为 `previous_response_id` 传入，即可继续同一会话，无需重发完整历史：

```json
{
  "model": "opencode/big-pickle",
  "input": "继续刚才的话题",
  "previous_response_id": "resp_abc123"
}
```

- 会话状态保留 30 分钟，过期后自动清理上游会话。
- ID 无效或过期返回 400 `Invalid or expired previous_response_id`。

## 🔧 工具调用

- 请求传入 `tools` 时走外部工具桥接：非流式返回标准 `message.tool_calls`（Responses API 在 `response.output` 中返回 `type: "function_call"` 项）；流式返回 `delta.tool_calls` 及 function_call 生命周期事件（`response.output_item.added`、`response.function_call_arguments.delta` / `done`、`response.output_item.done`）。
- 请求未传入 `tools` 时走内置工具 allowlist 模式，详见 [配置详解](./configuration.md)。
- 代理内部使用命名空间隔离同名工具，内部名称不会出现在公开 API 响应中。

### 两段式工具调用建议

agent 客户端（OpenClaw、Claude Code 等）建议把「调工具」和「答问题」拆成两跳，比混在一条消息里更稳定：

```text
# 第一跳：只要求产出工具调用
Call weather_lookup for Tokyo now. Do not answer directly.

# 收到 tool_calls / function_call 并执行后，回灌工具结果，再发第二跳
Great, now answer the original request using the tool result.
```

## 🧭 推理强度

| 输入值 | 映射结果 |
|:-------|:---------|
| `minimal` | `none` |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `high` |

## ⚠️ 错误响应

中间件自身的错误形如 `{"error": {"message": ..., "type": ..., "code": ...}}`；直连上游时，上游原生错误体会原样透传（例如 `{"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}`）。

### 401 Unauthorized

```json
{
  "error": {
    "message": "Invalid API key",
    "type": "invalid_request_error",
    "code": "invalid_api_key"
  }
}
```

### 404 Not Found

```json
{
  "error": {
    "message": "Model not found",
    "type": "invalid_request_error",
    "code": "model_not_found"
  }
}
```

### 500 Internal Server Error

```json
{
  "error": {
    "message": "Internal server error",
    "type": "server_error",
    "code": "internal_error"
  }
}
```

### 503 Service Unavailable

会话相关的两种 503：
> **按会话串行**：`/v1/chat/completions` 与 `/v1/responses` 都只对同一 conversation key 串行化；不同会话可以并发执行。同一会话的锁等待超过上限时返回 `503 conversation_busy`。


```json
{ "error": { "message": "Conversation is busy with another request", "type": "conversation_busy" } }
```

同一段对话已有请求在处理，本次等待超过「请求超时 + 60 秒」——避免整段对话被卡死的轮次永久占住。

```json
{ "error": { "message": "Could not read the session state for this conversation; retry the request", "type": "session_state_unavailable" } }
```

复用会话时读不到会话状态：此时无法区分"上一轮的回答"和"本轮的回答"，代理宁可失败也不返回陈旧内容，重试即可。

### 504 Gateway Timeout

```json
{ "error": { "message": "Request timeout", "type": "timeout", "code": "timeout" } }
```

上游在 `REQUEST_TIMEOUT_MS` 内没有产出（含 `/v1/responses` 的非流式请求）。客户端中途断开连接时，本轮会立即收尾并释放会话锁，不影响同一对话的下一次请求。

### 402 / 429

上游额度不足或限流时，按上游语义映射为 `402 insufficient_quota` / `429 rate_limit_exceeded`。
