# Changelog

All notable changes to this project will be documented in this file.

> This changelog starts with `3.0.0`, the release that reworked and renamed the
> project.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - 2026-10-04

Repositioned as the compatibility layer between an OpenAI-format gateway
(NewAPI, LiteLLM, ...) and OpenCode, and renamed to `opencode-gateway`.

### Changed

- **Renamed**: package, plugin file (`opencode-gateway-tool-lock.js`), session-title prefix, and the `OPENCODE_GATEWAY_*` environment prefix, with no compatibility aliases for the old names.
- **401 body aligned with the docs**: an unauthorised request now answers `{"error":{"message":"Invalid API key","type":"invalid_request_error","code":"invalid_api_key"}}` instead of a bare `{"message":"Unauthorized"}`. `/health/details` and `/metrics` keep their plain-text 401/404 probe responses.
- **Layered architecture**: the 4.6k-line `src/proxy.js` monolith is gone, replaced by focused modules — `src/config` (validated config, effective defaults on load), `src/logging` (structured, redacting), `src/errors` (taxonomy + OpenAI mapping), `src/http` (auth, CORS, request context, body limits), `src/conversation` (identity, store, planner, baseline, registry), `src/upstreams` (direct client, runtime client, router), `src/tools` (text tool contract) and `src/routes` (thin surfaces) — assembled by `src/app.js`, `src/bootstrap.js` and `src/server.js`. Every endpoint, header, error code, environment variable name and default stays as documented.
- **Engineering**: ESLint (flat config), Prettier and `tsc --checkJs` over every module; a CI workflow running lint, format, typecheck, unit and contract tests; and three suites — unit (`npm test`), contract (`npm run test:contract`, api-reference item by item) and independent verification (`npm run test:verify`) — plus `npm run test:all` as the single gate.
- **Packaging rewritten from scratch**: two-stage Dockerfile, `gosu` from Debian packages, PUID/PGID defaults taken from the image's `node` account, an in-container healthcheck, compose carrying the full documented environment surface with log rotation, and integration/smoke scripts with explicit exit codes (0 pass, 1 failure, 2 missing docker/daemon).
- **Defects found by the independent verification pass and fixed**: a queued turn no longer re-sends a turn the session already holds (it re-plans from the state the lock holder left); a direct turn with `previous_response_id` no longer pins a baseline and 503s before calling upstream; a failing model-catalog endpoint keeps that endpoint's previous list; SSE relay is byte-faithful including CRLF framing and an unterminated tail; and the tool contract reminder is appended again (the rewrite had dropped it, costing the documented parse-rate improvement).
- **Stricter configuration handling**: a malformed `config.json` fails fast, a non-numeric `PORT` is rejected, and an empty environment variable now means "unset" everywhere (previously most booleans read `''` as `false`). Malformed JSON bodies answer `400 Invalid JSON in request body`, oversized bodies `400 Request body too large`.
- **Positioning**: the local OpenCode runtime is no longer on the critical path — it serves the free tier, while Go and paid Zen traffic goes straight to OpenCode's own endpoints.
- **Licensing**: the project is licensed under MIT with its own copyright line.

### Added

- **Conversation session reuse**: a client that identifies its conversation with a request header (`session-id`, `x-deepseek-harness-session-id`, `x-opencode-session`, ...) now keeps one backend session across turns instead of getting a fresh one per request, and only the appended turns are sent, since the session already holds the earlier ones. The provider sees a stable `x-opencode-session`, which prompt caching and routing affinity need (OpenCode Zen/Go). Identity + model + tool policy select the session; a rewritten history, a model change, or a retry starts a clean one; idle conversations expire after `SESSION_TTL_MS` (30 minutes by default), and the map is capped at 1000 entries. Requests without such a header keep the previous stateless behaviour. Configure with `OPENCODE_PROXY_SESSION_REUSE`, `OPENCODE_PROXY_SESSION_TTL_MS`, and `OPENCODE_PROXY_SESSION_HEADERS`.

- **Derived conversation identity**: gateways that cannot forward a session header can now opt into session affinity with `SESSION_DERIVE_ENABLED` (`OPENCODE_PROXY_SESSION_DERIVE`). The conversation is anchored on the client scope (credential, client address, model, tool policy) plus its first message and resumed by matching the delivered transcript prefix. Look-alike conversations that content cannot tell apart are never merged — the lookup refuses and a fresh session is used — and the echoed answer is used to disambiguate when prefixes match.

- **Direct upstream for Go and paid Zen**: models served by OpenCode's own OpenAI-compatible endpoints (`opencode-go/*`, paid `opencode/*`) are now sent straight there with the upstream key, the official client fingerprint, and the same stable conversation header, instead of being driven through the local runtime. The request and response bodies pass through as-is (native tool calls, upstream error shapes and SSE included; only the `model` field is rewritten back), and a refusal (`401/403`) or transport failure falls back to the runtime unless `DIRECT_FALLBACK_TO_RUNTIME=false`. Free-tier Zen models stay on the runtime: their gate is an official-client identity that header spoofing cannot reproduce (verified `403 FreeTierError`).

- **Direct upstream covers `/v1/responses` and `/v1/models`**: Responses requests pass straight through (the upstream has the route, and `previous_response_id` stays the upstream's own id), and when the runtime cannot list models `/v1/models` is served from the direct upstream catalogs, which are public. Model resolution uses that same catalog, so `chat/completions`, `responses` and `models` all work with no runtime at all. Free-tier models without the `-free` suffix are learned from a `403 FreeTierError` and routed to the runtime from then on, so the fallback costs one round trip at most.

### Fixed

- **Direct conversations kept their session**: the conversation entry now records which upstream owns it, so a direct conversation reuses the same `x-opencode-session` on every turn (and its synthetic id is never sent to the runtime for deletion).
- **Stale answers on any session that already holds turns**: polling and the event stream now ignore the messages and parts that existed when the turn started. This covers both a reused conversation and a `previous_response_id` chain. When that state cannot be read, the turn fails with `503 session_state_unavailable` rather than falling back to unfiltered polling, which would serve the previous answer as this turn's.
- **Retry no longer truncates a reused conversation**: rotating to a fresh session after a transient upstream error re-sends the full history instead of the delta that only made sense for the session holding the earlier turns.
- **Rewrite detection covers the whole delivered prefix**: an edit, truncation, or reorder of an earlier turn — not just of the last one — starts a clean session, so the model never answers against a history the client replaced.
- **Failed turns no longer leak sessions**: the chat 502 path and the `/v1/responses` error path close the session the turn owned, and eviction/sweeping skip sessions a live response chain still references.
- **Bounded conversation wait**: a turn on a conversation with a request already in flight waits at most the request timeout plus 60 seconds and then reports `503 conversation_busy`, instead of queueing that conversation forever behind a wedged turn.
- **Hung and abandoned turns**: a non-streaming `/v1/responses` prompt now honours `REQUEST_TIMEOUT_MS` (`504 timeout`) instead of waiting on the upstream forever, and a client that disconnects mid-stream ends its turn at once — the collection stops, the conversation lock is released, and the next request on that conversation is served immediately rather than after the idle/request timeout.

- **Free Models Rejected (#17, #18)**: OpenCode Zen free models (all but `space-bunny-free`) refuse requests whose tool list differs from the official client's. Tools are no longer disabled per request; the backend loads `plugin/opencode-gateway-tool-lock.js`, the tool policy rides in the session title, and the plugin blocks tools at execution time. Internal allowlists keep working, and native calls to bridged external tools are steered back to the text contract.
- **Docker Startup Hang (#17)**: The entrypoint's health probe ran `curl` without a timeout against `/health`, which is not an OpenCode API route; a connection made while the backend was still booting never returned. The proxy now starts and supervises the backend itself (`MANAGE_BACKEND` defaults to `true`) and probes `/global/health`.
- **Backend Password**: `OPENCODE_SERVER_PASSWORD` and `OPENCODE_ZEN_API_KEY` are passed to the managed backend as environment variables; the old `--password` flag does not exist and kept the backend from starting.

### Removed

- **Third-party notice**: the original code this project was derived from has been fully replaced — `src/**`, `plugin/**`, `index.js` and the test suites are new implementations, and the packaging layer was rewritten from scratch (similarity to the original dropped to 38–54%, remaining overlap being unavoidable configuration vocabulary such as `.editorconfig`/`.gitignore` tokens and Docker/compose directives). With no substantial portion of the original software left, `NOTICE` was removed and `LICENSE.md` is now the only licensing document.

- `SEND_TOOL_OVERRIDES` / `OPENCODE_GATEWAY_SEND_TOOL_OVERRIDES`: the proxy picks plugin or override mode by checking the backend's loaded plugins.
