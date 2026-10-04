# Changelog

All notable changes to this project will be documented in this file.

> Entries up to and including `2.0.0` belong to the upstream project this one is
> derived from ([OpenCode2API](https://github.com/TiaraBasori/OpenCode2API), MIT)
> and are kept for history. Everything after that documents opencode-gateway.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

- `SEND_TOOL_OVERRIDES` / `OPENCODE_GATEWAY_SEND_TOOL_OVERRIDES`: the proxy picks plugin or override mode by checking the backend's loaded plugins.

## [2.0.0] - 2026-09-25

### Added

- **English README**: Added `README.en.md` with a language switch between the Chinese and English docs.
- **English Docs**: Added full `docs/en/` translations of every guide; Chinese guides now live under `docs/zh/`.
- **Test Layout**: Split tests into `tests/unit/`, `tests/integration/`, and `tests/manual/`; added `npm run test:stream` for the live streaming smoke test and scoped Jest to `tests/unit`.

### Changed

- **Integration Script**: `tests/integration/test-integration.sh` accepts `TEST_API_KEY`; the manual streaming smoke test now documents its usage and stays out of CI.
- **Documentation Overhaul**: Rewrote the README and `docs/` for accuracy and concision; documented `previous_response_id` session chaining, the full environment-variable surface, and corrected env var names to match the implementation (`OPENCODE_DISABLE_TOOLS`, `OPENCODE_USE_ISOLATED_HOME`, `OPENCODE_PROXY_PROMPT_MODE`, etc.).
- **Config Surface Consistency**: `.env.example`, `docker-compose.yml`, and the `Dockerfile` now set `OPENCODE_DISABLE_TOOLS` instead of `DISABLE_TOOLS`, which the proxy never read.

## [1.5.0] - 2026-04-18

### Added

- **External Tool Bridge**: Added proxy-level bridging for external OpenAI-compatible `tools` across `/v1/chat/completions` and `/v1/responses`.
- **Streaming Tool Call Parity**: Added streaming support for external tool calls in both Chat Completions and Responses APIs.
- **Explicit External Tool Config**: Added explicit `EXTERNAL_TOOLS_MODE=proxy-bridge` and `EXTERNAL_TOOLS_CONFLICT_POLICY=namespace` configuration surface and documentation.

### Changed

- **Project Version**: Bumped the repository version to `1.5.0` across package metadata and documentation badges.

### Fixed

- **Jest Test Shutdown**: Removed a lingering queue rescheduling timer from the proxy request lock flow and updated the default test command to use the verified clean Jest invocation, eliminating the previous generic open-handle warning during `npm test`.

## [1.0.0] - 2025-04-11

### Added

- **OpenAI-compatible API**: `/v1/models`, `/v1/chat/completions`, `/v1/responses` endpoints
- **Streaming Support**: Full SSE streaming for Chat Completions and Responses API
- **Model Aliases**: GPT-style model aliasing (e.g., `gpt5-nano` → `gpt-5-nano`)
- **Docker Deployment**: Complete Docker setup with healthcheck and volume management
- **Configuration**: Environment variables and config.json support
- **Auto Cleanup**: Configurable automatic conversation/session storage cleanup

### Changed

- **Default Security**: `DISABLE_TOOLS` defaults to `true` for safer out-of-box behavior
