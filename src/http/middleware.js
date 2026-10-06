/**
 * Express middleware that belongs to the HTTP edge: CORS, body limits and the
 * terminal error/404 handlers. No business logic lives here.
 *
 * @module http/middleware
 */

import cors from 'cors';
import express from 'express';

import { DEFAULT_SESSION_HEADER_NAMES } from '../config/index.js';
import { InvalidRequestError, asGatewayError, toOpenAIError } from '../errors/index.js';

/** Body limit shared by the JSON and urlencoded parsers. */
export const DEFAULT_JSON_BODY_LIMIT = '50mb';

/**
 * @typedef {object} CorsOptions
 * @property {readonly string[]} [headerNames] Conversation headers clients may send.
 * @property {string} [origin] Allowed origin; defaults to `*`.
 * @property {readonly string[]} [methods] Allowed methods.
 */

/**
 * Build the CORS middleware.
 *
 * Conversation identity headers are request inputs, so browser clients must
 * survive the preflight when they send one.
 *
 * @param {CorsOptions} [options] CORS options.
 * @returns {import('express').RequestHandler} Express middleware.
 */
export function createCorsMiddleware(options = {}) {
    const headerNames = options.headerNames ?? DEFAULT_SESSION_HEADER_NAMES;
    return cors({
        origin: options.origin ?? '*',
        methods: [...(options.methods ?? ['GET', 'POST', 'OPTIONS'])],
        allowedHeaders: ['Content-Type', 'Authorization', ...headerNames]
    });
}

/**
 * @typedef {object} BodyParserOptions
 * @property {string | number} [limit] Maximum body size; defaults to {@link DEFAULT_JSON_BODY_LIMIT}.
 */

/**
 * Build the JSON and urlencoded body parsers, in application order.
 *
 * `express.json()`/`express.urlencoded()` are used instead of `body-parser`
 * (`docs/ARCHITECTURE.md` §3).
 *
 * @param {BodyParserOptions} [options] Parser options.
 * @returns {[import('express').RequestHandler, import('express').RequestHandler]} `[json, urlencoded]`.
 */
export function createBodyParsers(options = {}) {
    const limit = options.limit ?? DEFAULT_JSON_BODY_LIMIT;
    return [express.json({ limit }), express.urlencoded({ extended: true, limit })];
}

/**
 * Translate body-parser failures into the gateway taxonomy.
 *
 * @param {unknown} error Thrown/forwarded error.
 * @returns {import('../errors/index.js').GatewayError} Gateway error.
 */
function mapBodyParserError(error) {
    if (error && typeof error === 'object') {
        const record = /** @type {{type?: unknown, status?: unknown, message?: unknown}} */ (error);
        if (typeof record.type === 'string' && record.type.startsWith('entity.')) {
            const message =
                record.type === 'entity.too.large'
                    ? 'Request body too large'
                    : 'Invalid JSON in request body';
            return new InvalidRequestError(message, { cause: error });
        }
    }
    return asGatewayError(error);
}

/**
 * @typedef {object} ErrorHandlerOptions
 * @property {import('../logging/logger.js').Logger} [logger] Logger for the failure.
 */

/**
 * Build the terminal error handler: log, then answer with the documented OpenAI
 * error shape.
 *
 * @param {ErrorHandlerOptions} [options] Handler options.
 * @returns {import('express').ErrorRequestHandler} Express error middleware.
 */
export function createErrorHandler(options = {}) {
    const logger = options.logger;

    /** @type {import('express').ErrorRequestHandler} */
    return function errorHandler(error, req, res, next) {
        if (res.headersSent) return next(error);

        const gateway = mapBodyParserError(error);
        logger?.error('request failed', {
            requestId: req.id,
            method: req.method,
            path: req.path,
            code: gateway.code,
            statusCode: gateway.statusCode,
            err: error
        });

        const { statusCode, body } = toOpenAIError(gateway);
        res.status(statusCode).json(body);
    };
}

/**
 * Build the terminal 404 handler for unknown routes.
 *
 * Unknown routes are outside `docs/zh/api-reference.md`, so
 * `docs/BEHAVIOUR-SPEC.md` §1 governs the shape: an informative
 * `Route not found: <METHOD> <path>` message with `type: not_found_error` and no
 * `code`.
 *
 * @returns {import('express').RequestHandler} Express middleware.
 */
export function createNotFoundHandler() {
    /** @type {import('express').RequestHandler} */
    return function notFoundHandler(req, res) {
        res.status(404).json({
            error: {
                message: `Route not found: ${req.method} ${req.path}`,
                type: 'not_found_error'
            }
        });
    };
}
