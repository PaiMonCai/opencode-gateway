/**
 * Upstream layer: the two ways out to OpenCode and the router that picks between
 * them.
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
 * The low-level helpers stay exported so routes and tests can reuse them. See
 * `docs/ARCHITECTURE.md` §2 for the frozen interfaces.
 *
 * @module upstreams
 */

export * from './direct-client.js';
export * from './runtime-client.js';
export * from './router.js';
export { resolveLogger, sleep, toBool, toMillis } from './support.js';
