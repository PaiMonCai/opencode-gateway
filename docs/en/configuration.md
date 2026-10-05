# ⚙️ Configuration

Priority: **env vars > config.json > defaults**.

Env vars use the `OPENCODE_` prefix; config.json uses the short names (see tables).

### Three tiers of settings

- **Core (worth knowing)**: `API_KEY` and `OPENCODE_SERVER_PASSWORD` (set both);
  `OPENCODE_ZEN_API_KEY` (only for the Go subscription / paid Zen);
  `OPENCODE_PROXY_PORT`; `PUID`/`PGID` (NAS ownership).
- **Common**: `OPENCODE_PROXY_OPS`, `OPENCODE_PROXY_STORAGE_CLEANUP`,
  `OPENCODE_DISABLE_TOOLS`, `OPENCODE_INTERNAL_ALLOWED_TOOLS`,
  `OPENCODE_PROXY_SESSION_DERIVE`, `OPENCODE_PROXY_REQUEST_TIMEOUT_MS`,
  `OPENCODE_PROXY_MAX_CONCURRENT_TURNS`, `OPENCODE_PROXY_UPSTREAM_PROXY`, `OPENCODE_PROXY_DEBUG`.
- **Advanced**: everything else in the tables below (upstream URLs, event
  timeouts, retries, prompt mode, session header names, …). The defaults are
  already tuned for the free tier; you normally never touch them.

### Merged and removed settings

These names **still work** (setting one takes effect) but print a deprecation
warning at startup naming the replacement, and they no longer appear in the
regular tables above.

- `OPENCODE_HEALTH_DETAILS_ENABLED` / `_REQUIRE_AUTH`, `OPENCODE_METRICS_ENABLED` / `_REQUIRE_AUTH` → **removed**; use `OPENCODE_PROXY_OPS=off|health|full` (both detail endpoints always require the bearer key)
- `OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS`, `OPENCODE_PROXY_CLEANUP_INTERVAL_MS`, `OPENCODE_PROXY_CLEANUP_MAX_AGE_MS` → **removed**; use `OPENCODE_PROXY_STORAGE_CLEANUP=off|hourly|daily`
- `OPENCODE_PROXY_DIRECT_FREE_VIA_RUNTIME` → removed: the free tier's gate is a client identity, so it can **only** be served by the runtime
- `OPENCODE_INTERNAL_TOOL_METRICS_ENABLED` → removed: the counters are always collected; expose them with `OPENCODE_PROXY_OPS=full`
- `OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY` → removed: there is one policy (same-name tools are namespaced)
- `OPENCODE_TOOL_DISCOVERY_FIXTURE` → removed: a test-only knob

> Exactly one behaviour changed: `/health/details` now **always** carries the
> `internal_tools.metrics` counters (the removed switch used to null them).

## 🔧 Environment Variables

### Service & Auth

| Env var | config.json | Default | Description |
|:---------|:------------|:-------|:-----|
| `OPENCODE_PROXY_PORT` / `PORT` | `PORT` | `10000` | Proxy listen port |
| `BIND_HOST` | `BIND_HOST` | `0.0.0.0` | Listen address |
| `OPENCODE_SERVER_PORT` | - | `10001` | Backend port, only used to build default `OPENCODE_SERVER_URL` |
| `OPENCODE_SERVER_URL` | `OPENCODE_SERVER_URL` | `http://127.0.0.1:10001` | OpenCode backend address |
| `OPENCODE_SERVER_PASSWORD` | `OPENCODE_SERVER_PASSWORD` | (empty) | Backend auth password |
| `API_KEY` | `API_KEY` | (empty) | Proxy Bearer key, no auth when unset |
| `OPENCODE_PROXY_MANAGE_BACKEND` | `MANAGE_BACKEND` | `true` | Proxy starts and manages the OpenCode backend process, which loads the tool-lock plugin |
| `OPENCODE_PATH` | `OPENCODE_PATH` | `opencode` | OpenCode binary path |
| `OPENCODE_ZEN_API_KEY` | `ZEN_API_KEY` | (empty) | Zen API key, passed to the managed backend as `OPENCODE_API_KEY` for paid models |
| `OPENCODE_USE_ISOLATED_HOME` | `USE_ISOLATED_HOME` | `false` | Use an isolated OpenCode config directory |

### Tool Control

| Env var | config.json | Default | Description |
|:---------|:------------|:-------|:-----|
| `OPENCODE_DISABLE_TOOLS` | `DISABLE_TOOLS` | `true` | Disable OpenCode built-in tools |
| `OPENCODE_EXTERNAL_TOOLS_MODE` | `EXTERNAL_TOOLS_MODE` | `proxy-bridge` | External tool bridge mode, only `proxy-bridge` is supported |
| `OPENCODE_INTERNAL_ALLOWED_TOOLS` | `INTERNAL_ALLOWED_TOOLS` | (empty) | Built-in tools allowed when request has no `tools`, comma-separated |
| `OPENCODE_INTERNAL_WEB_FETCH_ENABLED` | `INTERNAL_WEB_FETCH_ENABLED` | `false` | Legacy switch: allows `web_fetch` by default when no allowlist is set |

### Prompts & Sessions

| Env var | config.json | Default | Description |
|:---------|:------------|:-------|:-----|
| `OPENCODE_PROXY_PROMPT_MODE` | `PROMPT_MODE` | `standard` | `standard` or `plugin-inject` |
| `OPENCODE_PROXY_OMIT_SYSTEM_PROMPT` | `OMIT_SYSTEM_PROMPT` | `false` | Ignore incoming system prompt |
| `OPENCODE_PROXY_STORAGE_CLEANUP` | `STORAGE_CLEANUP` | `off` | Sweep stored conversations: `off` / `hourly` / `daily` |
| `OPENCODE_PROXY_REQUEST_TIMEOUT_MS` | `REQUEST_TIMEOUT_MS` | `180000` | Request timeout (ms) |
| `OPENCODE_PROXY_MAX_CONCURRENT_TURNS` | `MAX_CONCURRENT_TURNS` | `20` | Process-wide maximum executing turns |
| `OPENCODE_PROXY_MAX_PENDING_TURNS` | `MAX_PENDING_TURNS` | `100` | Maximum turns waiting for global capacity; excess turns fail immediately |
| `OPENCODE_PROXY_CONCURRENCY_WAIT_MS` | `CONCURRENCY_WAIT_MS` | `2000` | Maximum capacity wait; `0` means fail fast, timeout returns `503 gateway_overloaded` |
| `OPENCODE_PROXY_SESSION_REUSE` | `SESSION_REUSE_ENABLED` | `true` | Reuse one backend session per client conversation header |
| `OPENCODE_PROXY_SESSION_TTL_MS` | `SESSION_TTL_MS` | `1800000` | Close an idle conversation after this long (ms) |
| `OPENCODE_PROXY_SESSION_HEADERS` | `SESSION_HEADER_NAMES` | (see below) | Comma-separated identity headers, first non-empty wins |
| `OPENCODE_PROXY_SESSION_DERIVE` | `SESSION_DERIVE_ENABLED` | `false` | Infer the conversation from the request when no session header is sent |
| `OPENCODE_PROXY_DIRECT` | `DIRECT_ENABLED` | `true` | Talk to OpenCode's own OpenAI-compatible endpoints (Go / paid Zen) |
| `OPENCODE_PROXY_DIRECT_GO_URL` | `DIRECT_GO_BASE_URL` | `https://opencode.ai/zen/go/v1` | Go subscription endpoint |
| `OPENCODE_PROXY_DIRECT_ZEN_URL` | `DIRECT_ZEN_BASE_URL` | `https://opencode.ai/zen/v1` | Paid Zen endpoint |
| `OPENCODE_PROXY_DIRECT_FALLBACK` | `DIRECT_FALLBACK_TO_RUNTIME` | `true` | Fall back to the runtime when the direct upstream refuses (401/403) or is unreachable |
| `OPENCODE_PROXY_UPSTREAM_PROXY` | `UPSTREAM_PROXY` | (empty) | Proxy for upstream egress: `socks5h://`, `socks5://`, `socks4a://`, `socks4://`, `http://`, `https://` (credentials allowed as `user:pass@`); the standard `ALL_PROXY`/`HTTPS_PROXY`/`HTTP_PROXY` are read as fallbacks |
| `OPENCODE_PROXY_UPSTREAM_PROXY_FOR_RUNTIME` | `UPSTREAM_PROXY_FOR_RUNTIME` | `true` | Hand the same proxy to the managed runtime, so the free tier's own egress uses it too |

### Conversation Session Reuse

The OpenAI surface is stateless, so by default the proxy creates a fresh backend session per request. Some providers (OpenCode Zen/Go with `x-opencode-session`) require every turn of one conversation to carry the same session identity, otherwise each turn looks like a brand new conversation and prompt caching plus routing affinity are lost.

With reuse enabled (the default), a client that sends a session identity header gets:

1. one backend session bound to that identity, reused by every turn — the provider sees a stable `x-opencode-session`;
2. only the **appended** turns are sent, because the session already holds the earlier ones (echoed assistant turns are skipped);
3. identity + model + tool policy together select the session, so any change starts a fresh one;
4. an edit, truncation, or reorder **anywhere in the delivered prefix** starts a fresh session with the full history sent;
5. a retry (transient upstream error) rotates to a new session and re-sends the full history, so the new session never holds half a conversation;
6. idle conversations are closed after the TTL (30 minutes by default, matching `previous_response_id`); rotation, failure, and the entry cap close sessions too.

Recognised headers, in priority order: `x-opencode-session`, `x-session-id`, `x-thread-id`, `x-conversation-id`, `x-deepseek-harness-session-id`, `session-id`, `session_id`, `thread-id`, `thread_id`, `conversation-id`, `conversation_id`.

```bash
# Two turns of one conversation: the second sends only the new turn while the
# upstream session stays the same.
curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" -H "session-id: conv-42" \
  -d '{"model":"opencode-go/kimi-k3","messages":[{"role":"user","content":"remember 41"}]}'

curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" -H "session-id: conv-42" \
  -d '{"model":"opencode-go/kimi-k3","messages":[
      {"role":"user","content":"remember 41"},
      {"role":"assistant","content":"OK"},
      {"role":"user","content":"what number did I ask you to remember?"}]}'
```

> Clients that send no session header keep the original stateless behaviour. Set `OPENCODE_PROXY_SESSION_REUSE=false` to disable reuse entirely.

**Error codes**: when the session state cannot be read on a reused conversation (the previous turn cannot be told apart from this one) the request fails with `503 session_state_unavailable` instead of returning stale content; while another request is using the same conversation a concurrent one gets `503 conversation_busy` (the wait is bounded by the request timeout plus 60 seconds). Different conversations may run in parallel, but only `MAX_CONCURRENT_TURNS` execute process-wide; up to `MAX_PENDING_TURNS` wait FIFO for capacity, and a full queue or a wait beyond `CONCURRENCY_WAIT_MS` returns `503 gateway_overloaded`.

### Two upstreams: direct and runtime

The middleware reaches opencode two ways, chosen per model:

| Model | Upstream | Why |
|:--|:--|:--|
| `opencode/*-free` (free tier) | **local runtime** | the free tier's gate is an official-client identity — a plain HTTP client is refused even with every header spoofed (`403 FreeTierError: OpenCode's free tier can only be used from within OpenCode`) |
| `opencode-go/*` (Go subscription) | **direct** to `…/zen/go/v1` | only the key is checked, no client gate (`401 AuthError` without one) |
| `opencode/<paid>` (pay-as-you-go Zen) | **direct** to `…/zen/v1` | same, needs Zen credit |

In direct mode:

- the request body is forwarded as-is (the upstream already speaks OpenAI): tools, `tool_choice`, `stream`, `reasoning_effort` all pass through natively, with no text-contract bridging;
- only three things are added: the upstream key (`OPENCODE_ZEN_API_KEY`), the official client fingerprint (`User-Agent`, `x-opencode-client`, `x-opencode-project`, `x-opencode-request`), and `x-opencode-session` carrying the stable conversation identity described above;
- the upstream response is relayed verbatim (status codes, rate limits, SSE), with only the `model` field rewritten back to the name the client asked for;
- a `401/403` (bad key / missing entitlement) or a transport failure falls back to the local runtime, unless `OPENCODE_PROXY_DIRECT_FALLBACK=false`, which surfaces the upstream error instead.

> Without `OPENCODE_ZEN_API_KEY` the direct path stays off and every request uses the runtime.

### Outbound proxy (SOCKS / HTTP)

Direct upstream calls can go through a proxy, which is what a deployment with a
SOCKS-only egress needs:

```bash
# SOCKS5, with the proxy resolving the target host (recommended)
OPENCODE_PROXY_UPSTREAM_PROXY=socks5h://user:pass@10.0.0.9:1080

# The standard variables work too, at a lower precedence:
# OPENCODE_PROXY_UPSTREAM_PROXY > ALL_PROXY > HTTPS_PROXY > HTTP_PROXY
ALL_PROXY=socks5h://10.0.0.9:1080
```

Behaviour:

- it covers **upstream egress only** (direct chat/responses to `opencode.ai` and
  the model catalogs); the managed runtime, its health check and the SDK are
  loopback traffic and are **never proxied** — `localhost`, `127.0.0.0/8` and
  `::1` bypass automatically;
- `NO_PROXY` (comma separated; domain suffixes like `.example.com`, `host:port`
  and `*` all work) adds to that bypass list;
- the free tier is served by the local runtime, so its **own egress has to use the
  proxy as well**: passing it on is on by default, and the child process receives
  it as `ALL_PROXY`/`HTTPS_PROXY`/`HTTP_PROXY` (plus `NODE_USE_ENV_PROXY=1` and a
  `NO_PROXY` containing the loopback addresses). Set
  `OPENCODE_PROXY_UPSTREAM_PROXY_FOR_RUNTIME=false` to keep the proxy to the
  direct path;
- configuring only the standard `ALL_PROXY`/`HTTPS_PROXY` does **not** pass
  anything on (the child inherits the container environment anyway, so it behaves
  the same);
- the startup banner prints `scheme://***@host:port` and **never leaks
  credentials**; an unusable scheme fails fast at startup.

What the direct path covers:

- `POST /v1/chat/completions` and `POST /v1/responses` (both routes exist upstream): the body is forwarded as-is and a `previous_response_id` is simply the upstream's own id, untouched by the proxy;
- `GET /v1/models`: when the runtime cannot list models, the direct upstream catalogs are used instead — `/models` is public there, so a runtime-less deployment still publishes a model list (ids as `opencode-go/<id>` and `opencode/<id>`, cached for 10 minutes). Model **resolution** uses the same catalog, so `chat/completions`, `responses` and `models` all work without a runtime;
- **free-tier learning**: free-tier models are not always suffixed (`opencode/big-pickle` is free without `-free`). A `403 FreeTierError` teaches the proxy to route that model to the runtime from then on (for an hour), so the fallback is paid at most once.

> Note: the upstream `/responses` route exists but is per-model — some models are only offered in the OpenAI `chat/completions` format, and the direct call relays `ModelError: ... is not supported for format openai` as-is. That is upstream semantics; the proxy does not rewrite it.

**No session header? (derived mode)**: with `OPENCODE_PROXY_SESSION_DERIVE=true` the proxy anchors a conversation on the client scope (credential + client address + model + tool policy) plus the first message, and resumes it by matching the delivered prefix:

- any gateway that only sends standard OpenAI fields gets session affinity without forwarding a header;
- look-alike conversations (same anchor, same prefix, even the same replies) are **never merged** — the proxy starts a fresh session rather than mixing two clients' contexts, and the two separate as soon as their content diverges;
- when prefixes are identical it prefers the answer the client echoes back to tell the conversations apart.

**Timeouts and disconnects**: non-streaming `/v1/responses` requests are covered by `REQUEST_TIMEOUT_MS` too (a hung upstream yields `504 timeout` instead of waiting forever), and a client that disconnects mid-stream ends its turn immediately, releasing the conversation for the next request instead of holding it until the idle or request timeout.

**Security note**: the session identity is client-controlled input. Generic names in the default list (`session-id`, `thread-id`, ...) let an intermediary that fills them with one constant value collapse several clients onto one upstream session; narrow `OPENCODE_PROXY_SESSION_HEADERS` to the single header you control if that matters. `prompt_tokens` / `input_tokens` are still estimated from the whole conversation even when only the appended turns are sent.

### Diagnostics & Debug

| Env var | config.json | Default | Description |
|:---------|:------------|:-------|:-----|
| `OPENCODE_PROXY_OPS` | `OPS` | `health` | Operational endpoints: `off` (only `/health`), `health` (adds `/health/details`) or `full` (adds `/metrics`); both detail endpoints always require the bearer key |
| `OPENCODE_PROXY_DEBUG` | `DEBUG` | `false` | Debug logs |
| `OPENCODE_GATEWAY_EVENT_FIRST_DELTA_TIMEOUT_MS` | - | `30000` | First-delta timeout for streaming |
| `OPENCODE_GATEWAY_EVENT_IDLE_TIMEOUT_MS` | - | `8000` | Idle timeout for streaming |

## 📄 config.json Example

```json
{
    "PORT": 10000,
    "API_KEY": "your-secret-api-key",
    "BIND_HOST": "0.0.0.0",
    "DISABLE_TOOLS": true,
    "EXTERNAL_TOOLS_MODE": "proxy-bridge",
    "INTERNAL_ALLOWED_TOOLS": ["web_fetch"],
    "USE_ISOLATED_HOME": false,
    "PROMPT_MODE": "standard",
    "OMIT_SYSTEM_PROMPT": false,
    "STORAGE_CLEANUP": "off",
    "REQUEST_TIMEOUT_MS": 180000,
    "MAX_CONCURRENT_TURNS": 20,
    "MAX_PENDING_TURNS": 100,
    "CONCURRENCY_WAIT_MS": 2000,
    "DEBUG": false,
    "OPENCODE_SERVER_URL": "http://127.0.0.1:10001",
    "OPENCODE_PATH": "opencode"
}
```

## 🛠️ Tool Control Details

### External Tool Bridge

- Client-supplied `tools` are not registered as OpenCode built-in tools. The proxy virtualizes them for the model.
- Model output is normalized to OpenAI-compatible `tool_calls` / `function_call` for the client.
- Same-name conflicts are isolated via an internal namespace (e.g. `external__web_fetch`). Namespace names are internal details, not public API.
- Once a request passes `tools` explicitly, OpenCode built-in tools stay disabled for that request.

### Tool-Lock Plugin

OpenCode Zen free models only accept requests whose tool list matches the official client's; disabling tools per request gets rejected (`free tier can only be used from within OpenCode`). So the backend the proxy starts loads `plugin/opencode-gateway-tool-lock.js`: the tool list stays intact, the tool policy rides in the session title, and the plugin blocks tools at execution time.

- With a backend you start yourself (`MANAGE_BACKEND=false`), add the absolute path of that file to the backend's `plugin` config. Otherwise the proxy falls back to per-request tool overrides and free models are rejected.

### Built-in Tool Allowlist

- When a request has **no** `tools`, the proxy enters internal allowlist mode. Only tools in `OPENCODE_INTERNAL_ALLOWED_TOOLS` are allowed.
- Tool names are compared ignoring case and underscores, so `web_fetch` matches OpenCode's `webfetch`.
- `OPENCODE_INTERNAL_WEB_FETCH_ENABLED=true` is a legacy shortcut: treated as `web_fetch` when no allowlist is set.
- The internal tool counters (mode selection, tool discovery, match results, fallback reasons) are **always collected** and exported on `/metrics`; tool return content is never logged.

### Request-level Allowlist Override

When a request has no `tools`, `opencode.internal_allowed_tools` in the request body overrides the server default allowlist. For isolation, the override is **intersect-only, never expands**:

```json
{
  "model": "opencode/kimi-k2.5",
  "messages": [{"role": "user", "content": "Fetch this URL"}],
  "opencode": {
    "internal_allowed_tools": ["web_fetch"]
  }
}
```

## 📊 Health Diagnostics & Metrics

- `/health` is always a lightweight check.
- `/health/details` returns structured diagnostic JSON when `OPENCODE_PROXY_OPS=health|full`; it always requires Bearer authentication (`OPS=off` returns 404):

```json
{
  "status": "ok",
  "proxy": true,
  "concurrency": {
    "active": 2,
    "pending": 1,
    "maxConcurrent": 20,
    "maxPending": 100,
    "waitTimeoutMs": 2000,
    "rejectedTotal": 0,
    "timedOutTotal": 0,
    "abortedTotal": 0
  },
  "internal_tools": {
    "config": {
      "allowed_tools": ["web_fetch"],
      "metrics_enabled": true,
      "discovery_fixture": []
    },
    "metrics": {
      "externalBridgeRequests": 12,
      "internalAllowlistRequests": 8,
      "disabledRequests": 21,
      "discoveryFailures": 1,
      "fallbackToDisabled": 2
    },
    "cache": {
      "tool_ids_cached": true,
      "tool_id_count": 1,
      "age_ms": 12000
    }
  }
}
```

- `/metrics` returns Prometheus text format only when `OPENCODE_PROXY_OPS=full` and always requires Bearer authentication; other modes return 404:

```text
opencode_internal_tool_mode_requests_total{mode="external_bridge"}
opencode_internal_tool_mode_requests_total{mode="internal_allowlist"}
opencode_internal_tool_mode_requests_total{mode="disabled"}
opencode_internal_tool_discovery_failures_total
opencode_internal_tool_fallback_disabled_total
opencode_internal_tool_cache_ids
opencode_gateway_turns_active
opencode_gateway_turns_pending
opencode_gateway_turn_limit
opencode_gateway_turn_pending_limit
opencode_gateway_turn_rejections_total
opencode_gateway_turn_wait_timeouts_total
opencode_gateway_turn_aborts_total
```

## 🎯 Prompt Mode

| Mode | Description |
|:-----|:-----|
| `standard` (default) | Standard mode, full prompt handling |
| `plugin-inject` | Plugin-inject mode, smaller model-side prompt, usually used with `OMIT_SYSTEM_PROMPT=true` |

## ⭐ Recommended Configs

### Docker Production

```env
API_KEY=your-secret-key
OPENCODE_SERVER_PASSWORD=your-password
OPENCODE_DISABLE_TOOLS=true
OPENCODE_INTERNAL_ALLOWED_TOOLS=web_fetch
OPENCODE_PROXY_PROMPT_MODE=plugin-inject
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_STORAGE_CLEANUP=daily
OPENCODE_PROXY_MAX_CONCURRENT_TURNS=20
OPENCODE_PROXY_MAX_PENDING_TURNS=100
OPENCODE_PROXY_CONCURRENCY_WAIT_MS=2000
```

### Local Development

```env
OPENCODE_DISABLE_TOOLS=false
OPENCODE_PROXY_DEBUG=true
```
