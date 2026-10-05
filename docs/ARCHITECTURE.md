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
- thin route adapters (`chat.js`, `responses.js`, `health.js`, `models.js`) contain no business logic;
- `routes/engine.js` remains the turn orchestrator, while low-coupling collaborators are extracted into focused modules such as `operations.js` and `model-resolver.js`;
- nothing outside `src/upstreams/*` knows about the SDK or upstream `fetch`;
- Express `req`/`res` may appear only in the HTTP edge and route/operational surface modules, not in conversation/upstream/tool state modules.

## 2. Modules and frozen interfaces

Signatures are the contract. Use JSDoc typedefs so `tsc --checkJs` validates them.

### src/config

```js
loadConfig({ env = process.env, file = null } = {}) -> Config   // frozen object, validated
assertSafePublicExposure(config)                                 // fail-fast listener exposure policy
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
transformUpstreamError(error) -> { statusCode, error } // route-compatible upstream mapping
isTransientUpstreamError(error) -> boolean            // retry policy (see §4)
```

Error codes are part of the public contract: `invalid_request_error`,
`model_not_found`, `insufficient_quota`, `rate_limit_exceeded`, `timeout`,
`conversation_busy`, `gateway_overloaded`, `session_state_unavailable`,
`internal_error`.

### src/conversation

```js
createConversationRegistry({ config, logger, clock }) -> Registry

// async
Registry.resolveTurn({ headers, scope, deliverable, previousSessionId }) -> {
  identity,          // { source: 'header' | 'derived' | 'none', header?, preview? }
  key,               // string | null
  entry,             // ConversationEntry | null   (mode: 'runtime' | 'direct')
  plan,              // TurnPlan { reuse, delta, deltaStartIndex, sentCount, sentDigest, rewrite,
                   //            rotation?, pinned? }
  baseline,          // { ok, messageIds, partIds } | null  (null in direct mode: nothing to filter)
  sessionId,         // upstream session to use (null while busy)
  busy,              // true when the conversation lock could not be taken → 503 conversation_busy
  release            // () => void — MUST be called in a finally block (a no-op when busy)
}

Registry.storeTurn({ key, sessionId, mode, plan, replyText, startKey })
Registry.discard({ key })            // drop entry + close the session it owned
Registry.sweep()                     // TTL + size caps

hasDeliverablePromptContent(messages, includeFromIndex) -> boolean
```

Identity comes from the first non-empty header in the configured order, and the
default order starts with `x-opencode-session`: a gateway operator sets that
header deliberately, so a client-supplied `session-id` must not override it.

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

Two deliberate, documented limits (fixed values, no environment variable):

- the hard cap on tracked conversations (1000 entries, 16 candidates per derived
  anchor) wins over an in-flight conversation: an entry holding a turn lock may
  still be evicted, and the upstream session closed, when the cap is reached;
- direct turns carry `baseline === null`, which means "nothing to filter", while
  a failed read on a reused runtime session is `baseline.ok === false` and must
  answer `503 session_state_unavailable`. Callers must not conflate the two.

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
  // async; `busy: true` means the caller answers 503 conversation_busy and still
  // releases through the returned turn.
  plan({ providerID, modelID, headers, deliverable, toolMode, toolsFingerprint }) -> {
    mode,            // 'direct' | 'runtime'
    reason,          // for logs
    turn,            // Registry.resolveTurn(...) result (lock already held)
    sessionId,       // from turn.sessionId; generated for a direct turn without one
    busy             // see above
  },
  fallback(turn, reason) -> void,  // reason: 'free-tier' | 'auth' | 'transport'
  allowsFallback() -> boolean      // DIRECT_FALLBACK_TO_RUNTIME
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
`registry`, `router`, `policy`, `validator`, internal allowlist resolution).
Same observable behaviour as today:
client `tools` are exposed as a text contract, native calls are steered back, and
the execution-time plugin enforces the policy carried in the session title.

### src/http and src/routes

```js
createApp({ config, logger, registry, router, tools }) -> express.Application

createModelResolver({ runtime, direct, logDebug }) -> {
  listModels(),
  resolveRequestedModel(model)
}

createOperationalSurface({
  config, capacityLimiter, allowedToolNames, discoveryFixture,
  internalToolMetrics, getToolCacheSnapshot
}) -> {
  handleHealth, handleHealthDetails, handleMetrics,
  getInternalToolDashboard, renderMetrics
}
```

Routes: `GET /health`, `GET /health/details`, `GET /metrics`,
`GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/responses`.

Current modularization boundary:

- `engine.js`: Chat/Responses turn orchestration and conversation/session state transitions;
- `runtime-attempt.js`: prompt dispatch + stream/poll observation ordering;
- `runtime-retry.js`: transient retry policy, failed-session rotation and backoff;
- `runtime-reconciliation.js`: event-stream → polling reconciliation and missing-delta recovery;
- `streaming/sse.js`: shared SSE framing plus direct-upstream stream relay;
- `streaming/chat-writer.js`: Chat Completions chunk rendering;
- `streaming/responses-writer.js`: Responses sequence numbers, output scaffolds and event rendering;
- `operations.js`: liveness, authenticated diagnostics and Prometheus rendering;
- `model-resolver.js`: runtime/direct catalog selection and client model-name resolution;
- `direct-turn.js`: one direct upstream attempt, fallback classification and downstream relay;
- `conversation/response-chains.js`: `previous_response_id` state;
- `conversation/storage-cleanup.js`: OpenCode storage sweeping and timer lifecycle;
- `concurrency/turn-limiter.js`: bounded process-wide turn capacity;
- `errors/mapping.js`: OpenAI/gateway/upstream error rendering and retry classification;
- `http/image-data.js`: remote multimodal image loading and data-URI conversion;
- `tools/internal-resolution.js`: built-in tool id normalization and allowlist resolution;
- `tools/stream-reconciliation.js`: end-of-stream parser/filter flush and cross-channel tool-call recovery.

The HTTP contract — endpoints, request fields, response shapes, error codes —
is exactly what `docs/{zh,en}/api-reference.md` documents. Refactors must not
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

## 4a. Runtime integration constraints

`plugin/opencode-gateway-tool-lock.js` is loaded by the OpenCode backend, not by
this process, so it obeys the runtime's loader, not ours. Two rules are load
bearing and are easy to break while editing:

1. **The plugin file exports exactly one symbol: its default factory.** The
   loader registers *every function export* of a plugin file as a plugin of its
   own; the bogus entries it creates make `Plugin.trigger` throw
   `TypeError: null is not an object` on every turn. Pure helpers therefore live
   in `plugin/tool-policy.js`, which must never be listed in the runtime's
   `plugin` configuration.
2. **The factory returns every hook the runtime calls** (`config`, `event`,
   `dispose`, `chat.message`, `chat.params`, `tool.execute.after`, plus the
   `tool.execute.before` that carries the policy). `Plugin.trigger` resolves a
   hook by name and calls it without checking that the plugin defined one, so a
   plugin with fewer hooks fails every prompt before the model is reached.

Both were verified against a real `opencode serve` 1.18.34: with the rules
respected a prompt answers normally and the policy still denies a `[tools:none]`
session while allowing a `[tools:*]` one; violating either rule answers 500 on
every turn. `tests/unit/tool-lock.test.js` pins the export surface and the hook
set, and `docs/{zh,en}/troubleshooting.md` documents the symptom.

The same reasoning applies to the tool list: the runtime rejects a request whose
tool list differs from the official client's, which is why the proxy leaves the
list alone and enforces the policy inside the plugin instead of stripping tools
per request.

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
