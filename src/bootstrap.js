/**
 * Runtime assembly: builds the upstream clients, conversation registry, upstream
 * router, turn engine and Express application from a resolved config. `index.js`
 * only loads config, calls this and listens; keeping the assembly here makes the
 * wiring testable (`tests/contract/boot.test.js`).
 *
 * @module bootstrap
 */

import { createConversationRegistry } from './conversation/index.js';
import { createApp } from './app.js';
import { createResponseChainIndex } from './routes/engine.js';
import { createDirectUpstream, createRuntimeUpstream, createUpstreamRouter } from './upstreams/index.js';
import { createUpstreamFetch } from './upstreams/proxy-fetch.js';

/**
 * @typedef {object} BuildRuntimeOptions
 * @property {import('./config/index.js').Config} config Resolved gateway configuration.
 * @property {any} [logger] Logger dependency.
 * @property {unknown} [sdk] SDK module (or client) for the runtime upstream;
 *   tests inject a fake.
 * @property {typeof fetch|null} [fetch] Fetch implementation for the direct
 *   upstream; defaults to the global one.
 * @property {() => Promise<void>} [ensureBackend] Awaits/starts the managed backend.
 */

/**
 * @typedef {object} Runtime
 * @property {import('express').Application} app Express application.
 * @property {any} runtime Runtime upstream.
 * @property {any} direct Direct upstream.
 * @property {any} registry Conversation registry.
 * @property {any} router Upstream router.
 * @property {any} responseChains `previous_response_id` chain index.
 * @property {any} engine Turn engine.
 */

/**
 * Pick the fetch the direct upstream should use: an injected fetch always wins
 * (tests rely on that), otherwise a configured `UPSTREAM_PROXY` builds a fetch
 * that dials the proxy, and without a proxy the built-in fetch is returned.
 *
 * @param {object} options Selection options.
 * @param {import('./config/schema.js').Config} options.config Resolved configuration.
 * @param {typeof fetch|null} [options.fetch] Fetch injected by the caller.
 * @param {import('./logging/index.js').Logger|null} [options.logger] Logger dependency.
 * @returns {typeof fetch|undefined} Fetch to inject, or undefined to let the client default.
 */
export function resolveUpstreamFetch({ config, fetch = null, logger = null }) {
    if (fetch) return fetch;
    if (!config.UPSTREAM_PROXY) return undefined;
    return createUpstreamFetch({
        proxyUrl: config.UPSTREAM_PROXY,
        noProxy: process.env.NO_PROXY || process.env.no_proxy || '',
        logger
    });
}

/**
 * Assemble the runtime graph.
 *
 * @param {BuildRuntimeOptions} options Assembly options.
 * @returns {Runtime} Everything `index.js` and the server layer need.
 */
export function buildRuntime({
    config,
    logger = null,
    sdk = null,
    fetch = null,
    ensureBackend = async () => {}
}) {
    const upstreamFetch = resolveUpstreamFetch({ config, fetch, logger });
    const runtime = createRuntimeUpstream({
        config,
        logger,
        ...(sdk ? { sdk } : {}),
        // The runtime client only uses this fetch for loopback health checks, and a
        // proxied fetch bypasses loopback; inject it only when the caller did.
        ...(fetch ? { fetch } : {})
    });
    const direct = createDirectUpstream({
        config,
        logger,
        ...(upstreamFetch ? { fetch: upstreamFetch } : {})
    });
    // The chain index is shared: the registry needs it to keep a session a live
    // `previous_response_id` chain still references from being closed.
    const responseChains = createResponseChainIndex({
        deleteSession: (sessionId) => runtime.deleteSession(sessionId),
        logger
    });
    const registry = createConversationRegistry({
        config,
        logger,
        sessionBackend: runtime,
        deleteSession: (sessionId) => runtime.deleteSession(sessionId),
        isSessionHeld: (sessionId) => responseChains.isHeld(sessionId)
    });
    const router = createUpstreamRouter({ config, logger, direct, runtime, registry });
    const app = createApp({
        config,
        logger,
        registry,
        router,
        responseChains,
        ensureBackend
    });

    return {
        app,
        runtime,
        direct,
        registry,
        router,
        responseChains,
        engine: app.locals.engine
    };
}
