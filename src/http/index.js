/**
 * Public surface of the HTTP edge module: the middleware stack shared by every
 * route, with no business logic.
 *
 * @module http
 */

import { createAuthMiddleware } from './auth.js';
import {
    createBodyParsers,
    createCorsMiddleware,
    createErrorHandler,
    createNotFoundHandler
} from './middleware.js';
import { createRequestContextMiddleware } from './request-context.js';

export {
    DEFAULT_AUTH_BYPASS_PATHS,
    createAuthMiddleware,
    extractBearerToken,
    hasValidBearerAuth,
    isAuthorized,
    shouldAllowOperationalEndpoint
} from './auth.js';
export {
    DEFAULT_JSON_BODY_LIMIT,
    createBodyParsers,
    createCorsMiddleware,
    createErrorHandler,
    createNotFoundHandler
} from './middleware.js';
export {
    REQUEST_ID_HEADER,
    createRequestContextMiddleware,
    createRequestId,
    getAbortSignal,
    getRequestContext,
    normalizeRequestId
} from './request-context.js';

/**
 * @typedef {object} HttpLayerOptions
 * @property {import('../config/schema.js').Config} [config] Resolved configuration.
 * @property {import('../logging/logger.js').Logger} [logger] Application logger.
 */

/**
 * @typedef {object} HttpLayer
 * @property {import('express').RequestHandler} cors
 * @property {import('express').RequestHandler} requestContext
 * @property {import('express').RequestHandler} jsonBody
 * @property {import('express').RequestHandler} urlencodedBody
 * @property {import('express').RequestHandler} auth
 * @property {import('express').ErrorRequestHandler} errorHandler
 * @property {import('express').RequestHandler} notFoundHandler
 */

/**
 * Build the HTTP edge middleware, in application order.
 *
 * The returned handlers are installed with {@link installHttpLayer}; keeping them
 * separate lets tests mount a subset.
 *
 * @param {HttpLayerOptions} [options] Layer options.
 * @returns {HttpLayer} Middleware stack.
 */
export function createHttpLayer(options = {}) {
    const { config, logger } = options;
    const [jsonBody, urlencodedBody] = createBodyParsers();

    return {
        cors: createCorsMiddleware({ headerNames: config?.SESSION_HEADER_NAMES }),
        requestContext: createRequestContextMiddleware({ logger }),
        jsonBody,
        urlencodedBody,
        auth: createAuthMiddleware({ apiKey: config?.API_KEY ?? '' }),
        errorHandler: createErrorHandler({ logger }),
        notFoundHandler: createNotFoundHandler()
    };
}

/**
 * Install the HTTP edge middleware on an Express app.
 *
 * Order matters: CORS first (so preflights are answered before auth), then the
 * request context and auth, then the body parsers. Authenticating before parsing
 * prevents unauthenticated clients from consuming CPU/memory with large bodies.
 * The error and 404 handlers
 * are returned rather than installed, because they must come last — after the
 * routes.
 *
 * @param {import('express').Application} app Express application.
 * @param {HttpLayerOptions} [options] Layer options.
 * @returns {HttpLayer} The installed stack, including the terminal handlers.
 */
export function installHttpLayer(app, options = {}) {
    const layer = createHttpLayer(options);
    app.use(layer.cors);
    app.use(layer.requestContext);
    app.use(layer.auth);
    app.use(layer.jsonBody);
    app.use(layer.urlencodedBody);
    return layer;
}
