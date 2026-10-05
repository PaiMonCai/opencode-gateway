# Behaviour spec

Wire-level behaviour the rewrite must reproduce. This is a specification, not a
description of the current code: it was extracted from the observable contract
(HTTP responses, stream event sequences, error bodies, plugin semantics) plus the
documented API in `docs/{zh,en}/api-reference.md`. Implement from here, not by
transplanting the previous implementation.

Anything explicitly listed as **ignored** today must stay ignored (or be rejected)
in the same way, so gateways see no surprise change.

## 1. Endpoints and auth

| Method | Path | Auth | Notes |
|:--|:--|:--|:--|
| GET | `/health` | none | `{"status":"ok","proxy":true}`, always 200 while the process lives |
| GET | `/health/details` | `HEALTH_DETAILS_REQUIRE_AUTH` | structured diagnostics (§7) |
| GET | `/metrics` | `METRICS_REQUIRE_AUTH` | Prometheus text (§7) |
| GET | `/v1/models` | Bearer when `API_KEY` set | runtime catalog, else upstream catalogs, else one fallback model |
| POST | `/v1/chat/completions` | Bearer when `API_KEY` set | streaming and non-streaming |
| POST | `/v1/responses` | Bearer when `API_KEY` set | streaming and non-streaming, `previous_response_id` chaining |
**Outbound proxy**: when `OPENCODE_PROXY_UPSTREAM_PROXY` (or the standard
`ALL_PROXY`/`HTTPS_PROXY`/`HTTP_PROXY` fallbacks) is set, direct upstream calls
and the model-catalog fetches dial the proxy; loopback targets always bypass it,
so the runtime, its health check and the SDK are unaffected. Bodies, statuses and
headers of proxied responses are relayed exactly as received (no transparent
decompression, repeated headers preserved).

**Conversation serialization**: `/v1/chat/completions` and
`/v1/responses` serialize turns only within the same conversation. Different
conversation keys may run concurrently; a waiter that cannot acquire its
conversation lock within the configured wait budget receives
`503 conversation_busy`.

| any | other | — | `404 {"error":{"message":"Route not found: GET /nope","type":"not_found_error"}}` (keep this informative shape; a bare `Not found` is not enough for a gateway operator) |

Malformed JSON bodies answer `400 {"error":{"message":"Invalid JSON in request body",...}}`
and an oversized body `400 {"error":{"message":"Request body too large",...}}`.

Auth failure: `401 {"error":{"message":"Invalid API key","type":"invalid_request_error","code":"invalid_api_key"}}`
(the documented OpenAI-shaped body; the pre-rewrite code answered a bare
`{"message":"Unauthorized"}`, and this rewrite aligns to the published contract).
`/health/details` and `/metrics` keep their plain-text `401 Unauthorized` /
`404 Not found` for an unauthenticated or disabled probe, exactly as today.

CORS allows any origin,
`GET/POST/OPTIONS`, and the headers `Content-Type`, `Authorization` plus every
configured conversation header. JSON bodies up to 50 MB.

Conversation headers (first non-empty wins, configurable order):
`x-opencode-session`, `x-session-id`, `x-thread-id`, `x-conversation-id`,
`x-deepseek-harness-session-id`, `session-id`, `session_id`, `thread-id`,
`thread_id`, `conversation-id`, `conversation_id`. The set is the same as
`docs/*/configuration.md`; `x-opencode-session` is deliberately first so a
client-supplied `session-id` cannot override the identity an operator configured
on the gateway.

## 2. Chat Completions

### Request fields

**Honoured**: `model`, `messages`, `tools`, `tool_choice`, `stream`,
`temperature`, `max_tokens`, `top_p`, `stop`, `reasoning_effort`,
`reasoning.effort`, `opencode` (our own extension, stripped before the request
leaves the process).

**Silently ignored** (unchanged from today): `frequency_penalty`,
`presence_penalty`, `n`, `seed`, `response_format`, `logprobs`, `top_logprobs`,
`parallel_tool_calls`, `service_tier`, `stream_options`, `user`, `metadata`.

`messages` must be a non-empty array, otherwise
`400 {"error":{"message":"messages array is required"}}`. A body whose deliverable
turns are all empty (for example only system messages) gives
`400 {"error":{"message":"messages must include at least one non-system text message"}}`
**before** any upstream session is created.

### Non-streaming response

```json
{
  "id": "chatcmpl-<uuid>",
  "object": "chat.completion",
  "created": <unix seconds>,
  "model": "<provider>/<model as requested>",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "<text|null>", "reasoning_content": "<text>", "tool_calls": [...] },
    "finish_reason": "stop | tool_calls"
  }],
  "usage": {
    "prompt_tokens": <ceil(promptChars/4)>,
    "completion_tokens": <content+reasoning estimate>,
    "total_tokens": <sum>,
    "completion_tokens_details": { "reasoning_tokens": <estimate> }
  }
}
```

- `reasoning_content` appears only when the model produced reasoning.
- `tool_calls` items: `{"id":"call_...","type":"function","function":{"name":"<namespaced or original>","arguments":"<json string>"}}`;
  when `tool_calls` is present `content` is `null` if there was no text, and
  `finish_reason` is `tool_calls`.
- When no external tools are declared the model's tool-call markup is stripped
  from the text and never surfaced.
- Token counts are estimates (`ceil(chars / 4)`), including on a reused
  conversation where `prompt_tokens` covers the **whole** conversation.

### Streaming response

`Content-Type: text/event-stream`, records are `data: <json>\n\n`:

1. zero or more `{"id","object":"chat.completion.chunk","created","model","choices":[{"index":0,"delta":{...},"finish_reason":null}]}`
   with `delta.reasoning_content` for thinking and `delta.content` for answer text,
   `delta.tool_calls` for tool calls (each with `index`, `id`, `type`, `function`);
2. a final chunk with `choices[{"index":0,"delta":{},"finish_reason":"stop"|"tool_calls"}]`
   and the `usage` block;
3. `data: [DONE]`.

Keep-alive comments may be emitted while waiting. If the client disconnects the
turn ends immediately (no further writes, conversation released).

**Echo assumption (runtime path)**: the leading `assistant` messages a client
appends to its history are treated as its echo of the previous answer and are not
re-sent into the session. When such a message does not match the answer the
session recorded, the proxy still skips it but logs a debug line
(`Skipped an echoed assistant turn that does not match the session answer`, with
`sessionId`, `messageIndex`, `expected`, `observed`, `preview`), so an operator can
spot clients that inject assistant text the model never produced.

## 3. Responses API

### Request fields

**Honoured**: `model`, `input` (string or item array), `instructions`, `tools`
(Responses shape, i.e. `{type:'function',name,description,parameters}`),
`tool_choice`, `stream`, `temperature`, `top_p`, `max_output_tokens`,
`reasoning.effort` / `reasoning_effort`, `previous_response_id`, plus our
`opencode` extension and a `messages`/`prompt` shorthand.

Input items accepted: `{type:'message',role,content:[{type:'input_text'|'output_text',text}]}`,
`{type:'function_call',...}`, `{type:'function_call_output'|'tool_result',...}`,
plain strings, `{role,content}` objects. `input` missing/empty →
`400 {"error":{"message":"input is required"}}`.

### Non-streaming response

```json
{
  "id": "resp_<uuid>",
  "object": "response",
  "created": <unix seconds>,
  "model": "<provider>/<model>",
  "reasoning": { "effort": "...", "summary": "..." },
  "output": [ { "type": "message", ... }, { "type": "function_call", ... } ],
  "usage": { "input_tokens": ..., "output_tokens": ..., "total_tokens": ...,
             "input_tokens_details": { "cached_tokens": 0 },
             "output_tokens_details": { "reasoning_tokens": ... } }
}
```

`reasoning` is omitted when there is none. Empty output text produces an empty
`output` array rather than a null item.

### Streaming events

In order, each as `data: <json>\n\n` with an increasing `sequence_number`:

`response.created`, `response.output_item.added`,
`response.content_part.added` (type `output_text`) or
`response.function_call_arguments.delta`/`.done` for tool calls,
`response.reasoning_summary_text.delta`/`.done` when reasoning arrives,
`response.output_text.delta` (chunks), `response.output_text.done`,
`response.content_part.done`, `response.output_item.done`,
`response.completed`, then `data: [DONE]`.

On failure after headers are sent: a `response.failed` event followed by
`[DONE]` — never a second `res.json()` (that used to kill the process).

### Chaining

`previous_response_id` refers to a response id this service issued within the
runtime path; the conversation continues in the same backend session (30-minute
TTL). An unknown or expired id on the runtime path gives
`400 {"error":{"message":"Invalid or expired previous_response_id"}}`; in direct
mode the id belongs to the upstream and is forwarded untouched.

## 4. Tool bridge (runtime path only)

1. Client `tools` are exposed to the model as a **text contract** in the system
   prompt; each tool is namespaced `external__<name>`.
2. Accepted model output formats (parser): canonical
   `<function_calls>{json}</function_calls>` (single object or array), DeepSeek
   DSML-style `|<...>|parameter` markup, `<function=name><parameter=key>value</parameter>`
   plus a stray `<invoke>`/`<parameter>` variant, and native tool calls
   (`tool_calls` / `function_call`).
3. Emitted call ids: `call_external__<tool>_<n>` for bridged calls, otherwise
   `call_<sanitized name>_<n>`; ids echoed by the client are preserved.
4. Replayed history uses `ASSISTANT: <function_calls>[{"id","name","arguments"}]</function_calls>`
   and `TOOL_RESULT: {"tool_call_id","name","content"}` lines.
5. `tool_choice: "required"` (or a forced function) that yields no call triggers
   one forced follow-up prompt asking for `<function_calls>` only.
6. Native calls to `external__*` are steered back to the text contract by the
   backend plugin, which enforces the policy carried in the session title:
   `opencode-gateway [tools:none|<tool,tool,...>|*]`. `*` allows everything,
   `none` denies everything, a list allows matches by name/namespace suffix.
   Sessions without a policy deny every tool.
7. Verbatim-sounding error message keepers: the plugin's refusal text mentions
   the tool name and that it is disabled; the steering error tells the model to
   reply with `<function_calls>{"name":...,"arguments":{...}}</function_calls>`.

In direct mode tools pass through natively; the text contract and the plugin are
not involved.

**Known edge case kept for parity**: when a stream ends *inside* a tool-call
block, the filter only drops the stray opening tag — the unterminated payload is
released as ordinary text (for example `{"name":"ext`). This is the pre-rewrite
behaviour, verified identical in the rewrite's parity corpus, and it is reachable
only with tools disabled and a truncated stream. Changing it is a deliberate
behaviour change and needs its own changelog entry, not a silent fix.

## 5. Upstream routing

| condition | upstream |
|:--|:--|
| no upstream key (`ZEN_API_KEY`) | runtime |
| provider `opencode-go` | direct `/zen/go/v1` |
| provider `opencode`, model not free-tier | direct `/zen/v1` |
| model ends with `-free`, or was learned from a `403 FreeTierError` | runtime |
| `DIRECT_ENABLED=false` | runtime |

Direct relay is **byte-faithful**: the upstream body is passed through unchanged,
including an SSE stream whose last record carries no trailing blank line (no
separator is synthesised) and the upstream's own status codes and error bodies.
A model catalog refresh failure for one endpoint keeps that endpoint's previous
list instead of dropping it.

Direct mode adds exactly: `Authorization: Bearer <key>`,
`x-opencode-session: <conversation id>`, `x-opencode-request: msg_<hex>`,
`x-opencode-client: cli`, `x-opencode-project: global`, and an
`opencode/<version> ...` `User-Agent`. Request/response bodies otherwise pass
through; `model` is mapped both ways. Upstream status and body are relayed
verbatim, including `401 {"type":"error","error":{"type":"AuthError",...}}` and
`403 FreeTierError`. `DIRECT_FALLBACK_TO_RUNTIME` (default true) turns a 401/403
or transport failure into a runtime attempt for that same turn.

## 6. Errors

Our own shape: `{"error":{"message":...,"type":...,"code":...}}`.

| status | type / code | when |
|:--|:--|:--|
| 400 | `invalid_request_error` | bad body, model not found is 404 |
| 401 | `invalid_request_error` | missing/wrong `Authorization` |
| 402 | `insufficient_quota` | upstream billing/credit signatures |
| 404 | `model_not_found` | unknown model, or upstream "model not found" |
| 429 | `rate_limit_exceeded` | upstream throttling signatures |
| 500 | `server_error` / `internal_error` | unexpected failure of ours (the documented api-reference body) |
| 502 | `OpenCodeError`/`APIError` | runtime turn failed with no content |
| 503 | `conversation_busy` | conversation lock wait exceeded (request timeout + 60s) |
| 503 | `session_state_unavailable` | baseline snapshot failed on a reused session |
| 504 | `timeout` | no completion within `REQUEST_TIMEOUT_MS` |

Transient retry policy: up to 3 attempts with `800ms * attempt` backoff, only
when the error matches `insufficient balance`, `credits?error`, `rate.?limit`,
`too many requests`, `worker request limit`, `overloaded`, `temporarily
unavailable`, `internal server error`, `bad gateway`, `service unavailable`,
`stream error`, and only when nothing has been streamed yet.

## 7. Operational surfaces

Startup banner (stdout, one line per setting): port, bind host, backend URL,
backend password `Configured|Not configured`, OpenCode path, API key, Zen API
key, disable tools, manage backend, external tools mode/conflict policy, internal
web_fetch, internal allowed tools, internal tool metrics, discovery fixture,
health details enabled/require auth, metrics enabled/require auth, use isolated
home, session reuse (`ttl ...s, headers: ...`), session identity derivation,
direct upstream (`go: ..., zen: ...`), free-tier/fallback switches, request
timeout, prompt mode, omit system prompt, auto cleanup, cleanup interval/max age,
event idle/first-delta timeouts, debug.

`/health/details` → `{"status","proxy","internal_tools":{"config":{"allowed_tools","metrics_enabled","discovery_fixture"},"metrics":{"externalBridgeRequests","internalAllowlistRequests","disabledRequests","discoveryFailures","fallbackToDisabled"},"cache":{"tool_ids_cached","tool_id_count","age_ms"},"audit":{"available","fields":[...]}}}`.

`/metrics` (Prometheus text):
`opencode_internal_tool_mode_requests_total{mode="external_bridge"|"internal_allowlist"|"disabled"}`,
`opencode_internal_tool_discovery_failures_total`,
`opencode_internal_tool_fallback_disabled_total`,
`opencode_internal_tool_cache_ids`.

Graceful shutdown on SIGINT/SIGTERM: stop accepting connections, kill a managed
backend, remove temporary jail directories.

## 8. Configuration

Every environment variable name, default, and `config.json` key documented in
`docs/{zh,en}/configuration.md` is part of the contract and must not change.
Precedence: environment > `config.json` > built-in default.

Deliberate hardenings of the previous behaviour (approved with the rewrite):

- a malformed `config.json` fails fast instead of warning and continuing;
- a non-numeric `PORT` (including `0`) is rejected instead of silently falling
  back to 10000;
- an empty environment variable means "unset" everywhere (the previous code
  treated `''` as `false` for most booleans);
- the startup banner reports the effective event-timeout defaults
  (`8000ms` / `30000ms`) rather than "default".
