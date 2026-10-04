/**
 * Runtime assembly.
 *
 * Builds everything the process needs from a resolved config: the upstream
 * clients, the conversation registry, the upstream router, the turn engine and
 * the Express application. `index.js` only loads config, calls this and listens;
 * keeping the assembly here makes the wiring itself testable (see
 * `tests/contract/boot.test.js`), which is how a missing dependency injection
 * would otherwise reach production unnoticed.
 *
 * @module bootstrap
 */

import { createConversationRegistry } from './conversation/index.js';
import { createApp } from './app.js';
import { createResponseChainIndex } from './routes/engine.js';
import { createDirectUpstream, createRuntimeUpstream, createUpstreamRouter } from './upstreams/index.js';

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
    const runtime = createRuntimeUpstream({
        config,
        logger,
        ...(sdk ? { sdk } : {}),
        ...(fetch ? { fetch } : {})
    });
    const direct = createDirectUpstream({
        config,
        logger,
        ...(fetch ? { fetch } : {})
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
