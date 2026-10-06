/**
 * Bearer authentication helpers and the global auth middleware: with `API_KEY`
 * set (`docs/zh/api-reference.md`), `/v1/*` requires
 * `Authorization: Bearer <API_KEY>`; an empty key disables auth. Operational
 * endpoints own their policy — see {@link shouldAllowOperationalEndpoint}.
 *
 * @module http/auth
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { AuthenticationError, toOpenAIError } from '../errors/index.js';

/**
 * Paths the global middleware never authenticates; the routes behind them apply
 * their own policy.
 *
 * @type {readonly string[]}
 */
export const DEFAULT_AUTH_BYPASS_PATHS = Object.freeze(['/', '/health', '/health/details', '/metrics']);

/**
 * Constant-time string comparison that does not leak length.
 *
 * @param {string} left First string.
 * @param {string} right Second string.
 * @returns {boolean} Whether both strings are equal.
 */
function safeEqual(left, right) {
    const leftDigest = createHash('sha256').update(left, 'utf8').digest();
    const rightDigest = createHash('sha256').update(right, 'utf8').digest();
    return timingSafeEqual(leftDigest, rightDigest);
}

/**
 * Extract the token from an `Authorization` header value.
 *
 * @param {unknown} headerValue Raw header value (may be an array).
 * @returns {string | null} Token, or `null` when the header is not a bearer header.
 */
export function extractBearerToken(headerValue) {
    const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (typeof raw !== 'string') return null;
    const match = raw.match(/^Bearer[ ]+(.+)$/i);
    return match ? match[1].trim() : null;
}

/**
 * Whether a request's `Authorization` header satisfies the configured key.
 *
 * An empty/absent `apiKey` disables authentication entirely.
 *
 * @param {unknown} headerValue Raw `Authorization` header value.
 * @param {string} [apiKey] Configured bearer key.
 * @returns {boolean} Whether the request is authorized.
 */
export function isAuthorized(headerValue, apiKey = '') {
    if (!apiKey || apiKey.trim() === '') return true;
    const token = extractBearerToken(headerValue);
    return token !== null && safeEqual(token, apiKey);
}

/**
 * Legacy-compatible alias: does this request carry a valid bearer key?
 *
 * @param {import('express').Request} req Incoming request.
 * @param {string} [apiKey] Configured bearer key.
 * @returns {boolean} Whether the request is authorized.
 */
export function hasValidBearerAuth(req, apiKey = '') {
    return isAuthorized(req.headers.authorization, apiKey);
}

/**
 * Whether an operational endpoint may be served, honouring its enabled/requireAuth
 * flags and, when required, bearer auth.
 *
 * @param {import('express').Request} req Incoming request.
 * @param {{enabled: boolean, requireAuth: boolean}} policy Endpoint policy.
 * @param {string} [apiKey] Configured bearer key.
 * @returns {boolean} Whether the endpoint may be served.
 */
export function shouldAllowOperationalEndpoint(req, policy, apiKey = '') {
    if (!policy.enabled) return false;
    if (!policy.requireAuth) return true;
    return hasValidBearerAuth(req, apiKey);
}

/**
 * @typedef {object} AuthMiddlewareOptions
 * @property {string} [apiKey] Bearer key; empty disables auth.
 * @property {readonly string[]} [bypassPaths] Exact paths that skip authentication.
 * @property {string} [realm] Realm used in the `WWW-Authenticate` challenge.
 */

/**
 * Build the global auth middleware.
 *
 * `OPTIONS` requests and {@link DEFAULT_AUTH_BYPASS_PATHS} pass through; anything
 * else needs the configured bearer key when one is set.
 *
 * @param {AuthMiddlewareOptions} [options] Middleware options.
 * @returns {import('express').RequestHandler} Express middleware.
 */
export function createAuthMiddleware(options = {}) {
    const apiKey = options.apiKey ?? '';
    const bypassPaths = options.bypassPaths ?? DEFAULT_AUTH_BYPASS_PATHS;
    const realm = options.realm ?? 'opencode-gateway';

    /** @type {import('express').RequestHandler} */
    return function authMiddleware(req, res, next) {
        if (req.method === 'OPTIONS' || bypassPaths.includes(req.path)) return next();
        if (isAuthorized(req.headers.authorization, apiKey)) return next();

        const { statusCode, body } = toOpenAIError(new AuthenticationError('Invalid API key'));
        res.setHeader('WWW-Authenticate', `Bearer realm="${realm}"`);
        res.status(statusCode).json(body);
    };
}
