/**
 * Application assembly.
 *
 * `createApp` builds the Express application from injected dependencies: the
 * HTTP edge (CORS, JSON parsing, auth, request context), the route table, and
 * the terminal 404/error handlers — in that order. It performs no business
 * logic itself.
 *
 * @module app
 */

import express from 'express';

import { installHttpLayer } from './http/index.js';
import { createTurnEngine } from './routes/engine.js';
import { createRoutes } from './routes/index.js';

/**
 * @typedef {object} CreateAppOptions
 * @property {import('./config/index.js').Config} config Resolved gateway configuration.
 * @property {any} [logger] Logger dependency.
 * @property {any} registry Conversation registry (`createConversationRegistry`).
 * @property {any} router Upstream router (`createUpstreamRouter`).
 * @property {any} [tools] Tool contract module, injectable for tests.
 * @property {any} [engine] Pre-built turn engine; built from the other options
 *   when omitted.
 * @property {any} [responseChains] `previous_response_id` chain index. The
 *   conversation registry needs the same instance (to keep chained sessions
 *   alive), so callers pass it here and into `createConversationRegistry`.
 * @property {() => Promise<void>} [ensureBackend] Awaits/starts the managed backend.
 */

/**
 * Build the Express application.
 *
 * @param {CreateAppOptions} options Application dependencies.
 * @returns {import('express').Application} Ready-to-listen application.
 */
export function createApp({
    config,
    logger = null,
    registry,
    router,
    tools = null,
    engine = null,
    responseChains = null,
    ensureBackend = async () => {}
}) {
    const app = express();
    const turnEngine =
        engine ||
        createTurnEngine({
            config,
            logger,
            registry,
            router,
            tools,
            responseChains,
            ensureBackend
        });

    // CORS → request context → auth → body parsers. The terminal handlers must
    // come last, after the routes.
    const layer = installHttpLayer(app, { config, logger });
    app.use(createRoutes({ engine: turnEngine }));
    app.use(layer.notFoundHandler);
    app.use(layer.errorHandler);

    // The server layer reads the engine back off the app for shutdown.
    app.locals.engine = turnEngine;
    app.locals.config = config;
    app.locals.logger = logger;

    return app;
}
