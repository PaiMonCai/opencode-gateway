# 🔌 API Reference

Base URL: `http://127.0.0.1:10000`. When `API_KEY` is set, `/v1/*` requests need `Authorization: Bearer <API_KEY>`.

## 📡 Endpoints

| Method | Path | Description |
|:-----|:-----|:-----|
| `GET` | `/health` | Health check |
| `GET` | `/health/details` | Structured diagnostics (exposed when `OPENCODE_PROXY_OPS` is `health` or `full`; Bearer always required) |
| `GET` | `/metrics` | Prometheus metrics (exposed when `OPENCODE_PROXY_OPS=full`; Bearer always required) |
| `GET` | `/v1/models` | List models (falls back to the public upstream catalogs when the runtime is unavailable) |
| `POST` | `/v1/chat/completions` | Chat Completions |
| `POST` | `/v1/responses` | Responses API |

## 🧭 Request headers

| Header | Purpose |
|:--|:--|
| `Authorization` | `Bearer <API_KEY>`, required when `API_KEY` is configured |
| `x-opencode-session` / `x-session-id` / `x-thread-id` / `x-conversation-id` / `x-deepseek-harness-session-id` / `session-id` / `session_id` / `thread-id` / `thread_id` / `conversation-id` / `conversation_id` | **Conversation identity**: the same value means the same conversation, and the middleware reuses one upstream session for it (only the appended turns are sent). The first non-empty header in that order wins; narrow the list with `OPENCODE_PROXY_SESSION_HEADERS` |
| `X-Forwarded-For` | Part of the isolation scope when conversation identity is derived (`SESSION_DERIVE_ENABLED=true`) |

With no such header the behaviour is one session per request (see the derived mode in [Configuration](./configuration.md) if you want automatic reuse).

## ⬆️ Upstream selection

The middleware picks the upstream per model; clients do not need to care:

| Model | Upstream | Notes |
|:--|:--|:--|
| `opencode-go/*` | direct to `https://opencode.ai/zen/go/v1` | Go subscription; request and response bodies forwarded as-is |
| paid `opencode/*` | direct to `https://opencode.ai/zen/v1` | pay-as-you-go Zen |
| `opencode/*-free` (and free-tier models learned from a refusal) | local runtime | the free-tier gate cannot be satisfied by a plain HTTP client |

In direct mode the upstream's status codes and bodies are relayed **verbatim** (`401 Invalid API key.`, `403 FreeTierError`, rate limits, ...); only the `model` field is rewritten to the name the client asked for. A refusal or transport failure falls back to the runtime unless `OPENCODE_PROXY_DIRECT_FALLBACK=false`.

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

| Param | Type | Required | Description |
|:-----|:-----|:-----|:-----|
| `model` | string | ✅ | Model ID |
| `messages` | array | ✅ | Message array |
| `tools` | array | - | External tool definitions, OpenAI-compatible function tools |
| `tool_choice` | string/object | - | Tool choice policy, handled per proxy bridge semantics |
| `stream` | boolean | - | Stream output |
| `temperature` | number | - | Temperature (0-2) |
| `top_p` | number | - | Nucleus sampling (0-1) |
| `max_tokens` | number | - | Max tokens |
| `reasoning_effort` | string | - | Reasoning effort |

```bash
curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

## 🧠 Responses API

```http
POST /v1/responses
```

| Param | Type | Required | Description |
|:-----|:-----|:-----|:-----|
| `model` | string | ✅ | Model ID |
| `input` / `prompt` / `messages` | string/array | ✅* | At least one is required |
| `previous_response_id` | string | - | Previous response ID, to continue a session |
| `tools` | array | - | External tool definitions |
| `stream` | boolean | - | Stream output |
| `reasoning_effort` | string | - | Reasoning effort |

> \* At least one of `input`, `prompt`, `messages`.

```bash
curl -N -X POST http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt5-nano",
    "input": "Say hello in one sentence",
    "reasoning": {"effort": "high"},
    "stream": true
  }'
```

### Session Resume (previous_response_id)

Pass the previous response ID as `previous_response_id` to continue the same session, no need to resend full history:

```json
{
  "model": "opencode/big-pickle",
  "input": "Continue the last topic",
  "previous_response_id": "resp_abc123"
}
```

- Session state is kept for 30 minutes. Expired upstream sessions are cleaned up automatically.
- Invalid or expired IDs return 400 `Invalid or expired previous_response_id`.

## 🔧 Tool Calls

- Requests with `tools` use the external tool bridge: non-streaming returns standard `message.tool_calls` (Responses API returns `type: "function_call"` items in `response.output`); streaming returns `delta.tool_calls` plus function_call lifecycle events (`response.output_item.added`, `response.function_call_arguments.delta` / `done`, `response.output_item.done`).
- Requests without `tools` use the built-in tool allowlist mode, see [Configuration](./configuration.md).
- The proxy uses namespace isolation for same-name tools internally. Internal names never appear in public API responses.

### Two-step Tool Call Pattern

Agent clients (OpenClaw, Claude Code, etc.) should split "call tools" and "answer" into two hops. It is more stable than mixing both in one message:

```text
# Hop 1: only ask for tool calls
Call weather_lookup for Tokyo now. Do not answer directly.

# After receiving tool_calls / function_call and running them, feed results back, then hop 2
Great, now answer the original request using the tool result.
```

## 🧭 Reasoning Effort

| Input | Mapped to |
|:-------|:---------|
| `minimal` | `none` |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `high` |

## ⚠️ Error Responses

The middleware's own errors look like `{"error": {"message": ..., "type": ..., "code": ...}}`. In direct mode the upstream's native error body is relayed instead (for example `{"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}`).

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

> **Per-conversation serialization**: `/v1/chat/completions` and
> `/v1/responses` serialize only turns that share the same conversation key.
> Different conversations may run concurrently. A waiter that exceeds the
> conversation-lock budget receives `503 conversation_busy`.

Three common reasons:

```json
{ "error": { "message": "Conversation is busy with another request", "type": "conversation_busy" } }
```

Another request is already using this conversation and this one waited longer than the request timeout plus 60 seconds — so a wedged turn cannot pin a conversation forever.

Different conversations may execute concurrently, but process-wide turn capacity is bounded. A full pending queue or a wait beyond `OPENCODE_PROXY_CONCURRENCY_WAIT_MS` returns:

```json
{ "error": { "message": "Gateway is at capacity; retry shortly", "type": "gateway_overloaded" } }
```

The response includes `Retry-After`; defaults are 20 executing turns, 100 pending turns, and a 2-second wait.

```json
{ "error": { "message": "Could not read the session state for this conversation; retry the request", "type": "session_state_unavailable" } }
```

The session state could not be read while reusing a conversation: the previous turn's answer cannot be told apart from this one, so the turn fails instead of returning stale content. Retrying is safe.

### 504 Gateway Timeout

```json
{ "error": { "message": "Request timeout", "type": "timeout", "code": "timeout" } }
```

The upstream produced nothing within `REQUEST_TIMEOUT_MS` (including non-streaming `/v1/responses`). A client that disconnects ends its turn at once and releases the conversation lock, so the next request on that conversation is unaffected.

### 402 / 429

Upstream quota and throttling errors map to `402 insufficient_quota` / `429 rate_limit_exceeded`.
