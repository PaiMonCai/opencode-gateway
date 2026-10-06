/**
 * Per-request context: a request id, a start timestamp, a scoped logger and an
 * {@link AbortSignal} that fires when the client disconnects. Nothing outside
 * `src/http/*` touches `req`/`res` (`docs/ARCHITECTURE.md` §1), so the layers
 * below receive plain values from here.
 *
 * @module http/request-context
 */

import { randomUUID } from 'node:crypto';

/** Response/echo header carrying the request id. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Maximum accepted length of a client-supplied request id. */
const MAX_REQUEST_ID_LENGTH = 128;

/** Request ids are echoed into responses and logs, so keep them conservative. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:@-]+$/;

/**
 * Request-scoped context attached to `req.context`.
 *
 * @typedef {object} RequestContext
 * @property {string} id Request id (from the client when valid, else generated).
 * @property {number} startedAt `Date.now()` when the request entered the app.
 * @property {AbortSignal} signal Aborted when the client disconnects.
 * @property {'client' | null} abortedBy Who aborted the request, if anyone.
 * @property {unknown} logger Scoped logger (or `null` when logging is disabled).
 */

/**
 * Generate a fresh request id.
 *
 * @returns {string} UUID v4 string.
 */
export function createRequestId() {
    return randomUUID();
}

/**
 * Accept a client-supplied request id only when it is short and boring.
 *
 * @param {unknown} value Raw header value.
 * @returns {string | null} Sanitized id, or `null` when unusable.
 */
export function normalizeRequestId(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > MAX_REQUEST_ID_LENGTH) return null;
    if (!REQUEST_ID_PATTERN.test(trimmed)) return null;
    return trimmed;
}

/**
 * @typedef {object} RequestContextOptions
 * @property {import('../logging/logger.js').Logger} [logger] Base logger; children are scoped per request.
 * @property {string} [headerName] Header read/echoed for the request id.
 * @property {() => string} [idFactory] Id generator, injectable for tests.
 */

/**
 * Build the request-context middleware.
 *
 * Sets `req.id`, `req.requestId`, `req.context` and `req.abortSignal`, and echoes
 * the id back in `x-request-id`.
 *
 * @param {RequestContextOptions} [options] Middleware options.
 * @returns {import('express').RequestHandler} Express middleware.
 */
export function createRequestContextMiddleware(options = {}) {
    const baseLogger = options.logger;
    const headerName = options.headerName ?? REQUEST_ID_HEADER;
    const idFactory = options.idFactory ?? createRequestId;

    /** @type {import('express').RequestHandler} */
    return function requestContextMiddleware(req, res, next) {
        const id = normalizeRequestId(req.headers[headerName]) ?? idFactory();
        const controller = new AbortController();

        /** @type {RequestContext} */
        const context = {
            id,
            startedAt: Date.now(),
            signal: controller.signal,
            abortedBy: null,
            logger: baseLogger ? baseLogger.child('http', { requestId: id }) : null
        };

        req.id = id;
        req.requestId = id;
        req.abortSignal = controller.signal;
        req.context = context;
        res.setHeader(headerName, id);

        res.once('close', () => {
            // 'close' also fires after a normal response; only a response that
            // never finished means the client went away.
            if (!res.writableEnded) {
                context.abortedBy = 'client';
                controller.abort();
            }
        });

        next();
    };
}

/**
 * Read the request context, if the middleware ran.
 *
 * @param {import('express').Request} req Incoming request.
 * @returns {RequestContext | undefined} Context, or `undefined`.
 */
export function getRequestContext(req) {
    return req.context;
}

/**
 * Read the request's abort signal.
 *
 * @param {import('express').Request} req Incoming request.
 * @returns {AbortSignal | undefined} Signal, or `undefined`.
 */
export function getAbortSignal(req) {
    return req.context?.signal ?? req.abortSignal;
}
