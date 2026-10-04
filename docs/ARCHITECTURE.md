# Architecture

`opencode-gateway` is the compatibility layer between an OpenAI-format gateway
(NewAPI, LiteLLM, one-api, ...) and OpenCode. Clients speak OpenAI; this service
reassembles their stateless requests into conversations, routes each model to the
upstream that can serve it, and relays what comes back faithfully.

This document is the **contract for the rewrite**: module boundaries, interfaces,
invariants, and the rules that must not change. Anything not written here is an
implementation detail.

Companion documents:

- [`docs/BEHAVIOUR-SPEC.md`](./BEHAVIOUR-SPEC.md) — the wire-level behaviour the
  rewrite must reproduce (request fields, response and SSE shapes, tool contract,
  error table, ops surfaces). Implement from it, never by transplanting the
  previous implementation.
- [`docs/zh/api-reference.md`](./zh/api-reference.md) / [`docs/en/api-reference.md`](./en/api-reference.md)
  — the user-facing contract. It wins over the behaviour spec if they disagree.

## 1. Layering

```
                 HTTP edge                     src/http, src/routes
        ┌───────────────────────────┐
        │ auth · json · limits      │
        │ request context (id, signal)
        └─────────────┬─────────────┘
                      │
        ┌─────────────▼─────────────┐
        │ conversation layer        │  src/conversation
        │ identity · store · planner│
        └─────────────┬─────────────┘
                      │
        ┌─────────────▼─────────────┐
        │ upstream router           │  src/upstreams/router.js
        │ model → direct | runtime  │
        └──────┬─────────────┬──────┘
               │             │
   src/upstreams/direct   src/upstreams/runtime
     (OpenAI HTTP)          (@opencode-ai/sdk + opencode serve)

  cross-cutting: src/config · src/logging · src/errors · src/tools · src/models
```

Rules:

- a layer may only import from layers **below** it and from `src/config`,
  `src/logging`, `src/errors`;
- `src/routes/*` contains no business logic: it parses, calls the conversation
  layer and the upstream router, and writes the response;
- nothing outside `src/upstreams/*` knows about the SDK or `fetch`;
- nothing outside `src/http/*` knows about `req`/`res`.

## 2. Modules and frozen interfaces

Signatures are the contract. Use JSDoc typedefs so `tsc --checkJs` validates them.

### src/config

```js
loadConfig({ env = process.env, file = null } = {}) -> Config   // frozen object, validated
describeConfig(config) -> { line: string }[]                     // startup banner, secrets redacted
```

`Config` keeps today's **environment variable names** (they are the public
interface) and today's defaults. Invalid values fail fast with a readable error.

### src/logging

```js
createLogger({ level, json, stream = process.stderr }) -> Logger
Logger.child(scope, fields?) -> Logger
Logger.debug|info|warn|error(message, fields?)
```

JSON lines in production (`json: true`), human-readable when `OPENCODE_PROXY_DEBUG`
is on. Never log secrets (api keys, passwords, bearer tokens).

### src/errors

```js
class GatewayError extends Error { statusCode; code; type; details; expose }
toOpenAIError(error) -> { statusCode, body }          // our own errors, OpenAI shape
isTransientUpstreamError(error) -> boolean            // retry policy (see §4)
```

Error codes are part of the public contract: `invalid_request_error`,
`model_not_found`, `insufficient_quota`, `rate_limit_exceeded`, `timeout`,
`conversation_busy`, `session_state_unavailable`, `internal_error`.

### src/conversation

```js
createConversationRegistry({ config, logger, clock }) -> Registry

Registry.resolveTurn({ headers, scope, deliverable, previousSessionId }) -> {
  identity,          // { source: 'header' | 'derived' | 'none', header?, preview? }
  key,               // string | null
  entry,             // ConversationEntry | null   (mode: 'runtime' | 'direct')
  plan,              // TurnPlan { reuse, delta, deltaStartIndex, sentCount, sentDigest, rewrite }
  baseline,          // { ok, messageIds, partIds } | null
  release            // () => void  — MUST be called in a finally block
}

Registry.storeTurn({ key, sessionId, mode, plan, replyText, startKey })
Registry.discard({ key })            // drop entry + close the session it owned
Registry.sweep()                     // TTL + size caps
```

Invariants (these are the product):

1. one conversation identity maps to one upstream session; the same session id is
   sent upstream on every turn of that conversation;
2. only the **appended** turns are sent to a runtime session; a client echoing
   the previous assistant answer does not duplicate it;
3. reuse requires a full-prefix match of the delivered transcript; any edit,
   truncation or reorder anywhere in the prefix starts a fresh session with the
   full history;
4. a retry that rotates to a new session re-sends the **full** history;
5. two conversations that content alone cannot tell apart are never merged — the
   lookup refuses instead;
6. a turn never reports the previous turn's answer: polling and event collection
   ignore message/part ids that existed before the turn started, and a failed
   snapshot fails the turn (`503 session_state_unavailable`) rather than falling
   back to unfiltered polling;
7. turns of one conversation are serialized; a waiter gives up after
   `requestTimeoutMs + 60s` with `503 conversation_busy`;
8. sessions the registry no longer tracks are closed, except direct sessions
   (nothing upstream to close) and sessions a live `previous_response_id` chain
   still references.

### src/upstreams

```js
createDirectUpstream({ config, logger, fetch = globalThis.fetch }) -> {
  chatCompletion(ctx) -> UpstreamResponse      // raw fetch Response
  responses(ctx) -> UpstreamResponse
  listModels() -> Model[]
  supports(providerID) -> boolean
}

createRuntimeUpstream({ config, logger, sdk }) -> {
  ensureReady(), createSession(toolControl), prompt(params), messages(id),
  deleteSession(id), subscribe(signal), listModels()
}

createUpstreamRouter({ config, logger, direct, runtime, catalog, registry }) -> {
  plan({ providerID, modelID, headers, deliverable, toolMode, toolsFingerprint }) -> {
    mode,            // 'direct' | 'runtime'
    reason,          // for logs
    turn,            // Registry.resolveTurn(...) result (lock already held)
    sessionId
  },
  fallback(turn, reason) -> void   // remembers runtime-only models, releases direct state
}
```

Routing rules (stable):

| model | upstream |
|:--|:--|
| `opencode-go/*` | direct → `zen/go/v1` |
| paid `opencode/*` | direct → `zen/v1` |
| `opencode/*-free` and models learned from a `403 FreeTierError` | runtime |
| no upstream key configured | runtime |

In direct mode the request and response bodies pass through **untouched** except
for `model` (bare upstream id out, client-facing name back) and the added
identity headers. Upstream errors are relayed verbatim (status + body). A `401`/
`403` or transport failure falls back to the runtime unless
`DIRECT_FALLBACK_TO_RUNTIME=false`.

### src/tools

Text-contract tooling for the runtime path only (`contracts`, `parser`,
`registry`, `router`, `policy`, `validator`). Same observable behaviour as today:
client `tools` are exposed as a text contract, native calls are steered back, and
the execution-time plugin enforces the policy carried in the session title.

### src/http and src/routes

```js
createApp({ config, logger, registry, router, tools }) -> express.Application
```

Routes: `GET /health`, `GET /health/details`, `GET /metrics`,
`GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/responses`.

The HTTP contract — endpoints, request fields, response shapes, error codes —
is exactly what `docs/{zh,en}/api-reference.md` documents. The rewrite must not
change it.

## 3. Cross-cutting requirements

- **Node**: ESM only, `engines.node >= 20`. Use global `fetch`; no axios.
- **Dependencies**: keep the runtime lean — `express`, `cors`, `@opencode-ai/sdk`.
  Prefer `express.json()`/`express.urlencoded()` over body-parser.
- **Types**: JSDoc on every exported symbol, checked by `npm run typecheck`.
- **Style**: ESLint (flat config) + Prettier, 4-space indent (`.editorconfig`),
  `npm run lint` / `npm run format:check` must pass in CI.
- **Tests**: Jest + supertest, ESM (`--experimental-vm-modules`), one suite per
  module under `tests/unit/<module>/`, plus `tests/contract/` for the documented
  HTTP contract and `tests/e2e/` for the real-runtime smoke test.
- **Coverage**: `npm run test:coverage`, thresholds only ratchet upwards.
- **CI**: every push/PR runs lint + typecheck + unit + contract tests; the image
  workflow stays tag-driven. CI must not require an OpenCode runtime or network.

## 4. Behaviour that must survive the rewrite

1. SSE streaming for chat completions and Responses, including `[DONE]`.
2. `previous_response_id` chaining with a 30-minute TTL for the runtime path.
3. `reasoning_effort` / `reasoning.effort` mapping and `reasoning_content` output.
4. Tool bridging: client `tools` → standard `tool_calls`; the tool-lock plugin
   stays the gate that keeps free-tier models usable.
5. Transient upstream errors are retried (`RETRY_MAX_ATTEMPTS`, exponential
   backoff) only when nothing has been streamed yet.
6. Operational surfaces: `/health`, `/health/details`, `/metrics` (Prometheus
   text), and the startup banner printed by `index.js`.
7. Graceful shutdown: on SIGINT/SIGTERM close the HTTP server, kill a managed
   backend, remove temp dirs.

## 5. Migration order

The rewrite lands module by module, each step keeping `npm test` green:

1. `src/config`, `src/logging`, `src/errors`, `src/http` + tooling (CI, lint,
   types) — no behaviour change;
2. `src/conversation` (pure logic, unit-tested in isolation) + contract tests for
   the conversation invariants in §2;
3. `src/upstreams` (direct client first — it has no runtime dependency — then the
   runtime client) + `plugin/`;
4. `src/tools` + `src/routes` + `src/app.js` + `index.js` wiring; delete the old
   `src/proxy.js` monolith in the same change;
5. docs, `docs/ARCHITECTURE.md` sync, and the final parity pass against
   `docs/{zh,en}/api-reference.md`.

Until step 5 completes, the old `src/proxy.js` keeps serving production traffic;
new modules are wired in behind it as they become ready.
