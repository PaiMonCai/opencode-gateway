/**
 * Upstream layer.
 *
 * Two ways out to OpenCode, plus the router that picks between them:
 *
 * - {@link createDirectUpstream} — OpenCode's own OpenAI-compatible endpoints
 *   (`/zen/go/v1`, `/zen/v1`). Bodies pass through untouched except for the
 *   `model` field and the official-client fingerprint headers; upstream errors
 *   are relayed verbatim.
 * - {@link createRuntimeUpstream} — the local OpenCode runtime through
 *   `@opencode-ai/sdk`. Required for the Zen free tier and the fallback for
 *   every direct failure unless `DIRECT_FALLBACK_TO_RUNTIME=false`.
 * - {@link createUpstreamRouter} — mode decision, free-tier learning and turn
 *   resolution.
 *
 * Nothing outside this directory knows about the SDK or `fetch`; the low-level
 * helpers stay exported so routes and tests can reuse them without building a
 * client. See `docs/ARCHITECTURE.md` §2 for the frozen interfaces.
 *
 * @module upstreams
 */

export * from './direct-client.js';
export * from './runtime-client.js';
export * from './router.js';
export { resolveLogger, sleep, toBool, toMillis } from './support.js';
