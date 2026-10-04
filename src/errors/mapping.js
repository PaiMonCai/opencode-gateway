/**
 * Translation between upstream/provider failures, this service's own
 * {@link GatewayError} taxonomy and the OpenAI-compatible HTTP error shape.
 *
 * @module errors/mapping
 */

import { ERROR_CODES, ERROR_STATUS_CODES, ERROR_TYPES, GatewayError } from './taxonomy.js';

/**
 * @typedef {object} OpenAIErrorResponse
 * @property {number} statusCode HTTP status to answer with.
 * @property {{error: {message: string, type: string, code: string}}} body Response body.
 */

/**
 * Generic client-facing message per status, used when the real message must not
 * be exposed.
 *
 * @param {number} statusCode HTTP status.
 * @returns {string} Safe message.
 */
function genericMessage(statusCode) {
    switch (statusCode) {
        case 400:
            return 'Invalid request';
        case 401:
            return 'Invalid API key';
        case 402:
            return 'Insufficient quota';
        case 403:
            return 'Permission denied';
        case 404:
            return 'Model not found';
        case 429:
            return 'Rate limit exceeded';
        case 502:
            return 'Bad gateway';
        case 503:
            return 'Service unavailable';
        case 504:
            return 'Request timeout';
        default:
            return 'Internal server error';
    }
}

/**
 * Read a numeric HTTP status out of a foreign error object, if it carries one.
 *
 * Accepts the shapes seen in practice: SDK errors (`statusCode`), fetch-style
 * errors (`status`) and the SDK's nested `data.status`.
 *
 * @param {unknown} error Candidate error.
 * @returns {number | null} Status in `[100, 599]`, or `null`.
 */
function readStatusCode(error) {
    if (!error || typeof error !== 'object') return null;
    const record = /** @type {{statusCode?: unknown, status?: unknown, data?: {status?: unknown}}} */ (error);
    for (const candidate of [record.statusCode, record.status, record.data?.status]) {
        if (typeof candidate === 'number' && candidate >= 100 && candidate <= 599) return candidate;
    }
    return null;
}

/**
 * Error code that best describes an upstream HTTP status.
 *
 * @param {number} statusCode Upstream status.
 * @returns {string} One of {@link ERROR_CODES}.
 */
export function codeForStatus(statusCode) {
    switch (statusCode) {
        case 400:
            return ERROR_CODES.INVALID_REQUEST;
        case 401:
            return ERROR_CODES.INVALID_API_KEY;
        case 402:
            return ERROR_CODES.INSUFFICIENT_QUOTA;
        case 403:
            return ERROR_CODES.PERMISSION_DENIED;
        case 404:
            return ERROR_CODES.MODEL_NOT_FOUND;
        case 429:
            return ERROR_CODES.RATE_LIMIT_EXCEEDED;
        case 504:
            return ERROR_CODES.TIMEOUT;
        default:
            return statusCode >= 500 ? ERROR_CODES.INTERNAL : ERROR_CODES.INVALID_REQUEST;
    }
}

/**
 * Wrap any thrown value in the {@link GatewayError} taxonomy.
 *
 * Foreign errors that carry an HTTP status keep that status (this is how an
 * upstream failure is surfaced without leaking a host-specific error class);
 * everything else becomes an {@link ERROR_CODES.INTERNAL} error.
 *
 * @param {unknown} error Thrown value.
 * @returns {GatewayError} Gateway error.
 */
export function asGatewayError(error) {
    if (error instanceof GatewayError) return error;

    if (error instanceof Error) {
        const statusCode = readStatusCode(error);
        if (statusCode !== null) {
            const code = codeForStatus(statusCode);
            return new GatewayError(error.message || genericMessage(statusCode), {
                code,
                statusCode,
                expose: statusCode < 500,
                cause: error
            });
        }
        return new GatewayError(error.message, {
            code: ERROR_CODES.INTERNAL,
            statusCode: ERROR_STATUS_CODES[ERROR_CODES.INTERNAL],
            type: ERROR_TYPES[ERROR_CODES.INTERNAL],
            expose: false,
            cause: error
        });
    }

    return new GatewayError(genericMessage(500), {
        code: ERROR_CODES.INTERNAL,
        expose: false,
        details: error
    });
}

/**
 * Render a thrown value as the documented OpenAI error response.
 *
 * The body always matches `{"error": {"message", "type", "code"}}`
 * (`docs/zh/api-reference.md` §错误响应). Messages of unexposed errors are
 * replaced by a generic one.
 *
 * @param {unknown} error Thrown value.
 * @returns {OpenAIErrorResponse} Status and OpenAI-shaped body.
 */
export function toOpenAIError(error) {
    const gateway = asGatewayError(error);
    const message = gateway.expose && gateway.message ? gateway.message : genericMessage(gateway.statusCode);
    return {
        statusCode: gateway.statusCode,
        body: {
            error: {
                message,
                type: gateway.type,
                code: gateway.code
            }
        }
    };
}

/**
 * Retry policy (architecture §4.5): is this upstream failure worth another
 * attempt? Retries only happen before anything has been streamed.
 *
 * Kept behaviourally identical to the pre-rewrite predicate in `src/proxy.js`:
 * signature match on the message first, then on a `<status>:` prefix or a
 * numeric status on the error object.
 *
 * @param {unknown} error Upstream error.
 * @returns {boolean} Whether the request may be retried.
 */
export function isTransientUpstreamError(error) {
    if (!error || typeof error !== 'object') return false;

    const record =
        /** @type {{message?: unknown, data?: {message?: unknown, status?: unknown}, statusCode?: unknown}} */ (
            error
        );
    const message = [record.message, record.data?.message]
        .filter((part) => typeof part === 'string')
        .join(' ');
    if (!message) return false;

    const transientSignatures = [
        /insufficient balance/i,
        /credits?error/i,
        /rate.?limit/i,
        /too many requests/i,
        /worker request limit/i,
        /overloaded/i,
        /temporarily unavailable/i,
        /internal server error/i,
        /bad gateway/i,
        /service unavailable/i,
        /stream error/i
    ];
    if (transientSignatures.some((pattern) => pattern.test(message))) return true;

    // Upstream errors arrive as "<status>: {json}" strings; SDK errors may also
    // carry a numeric status on the object itself.
    const statusMatch = message.match(/\b(\d{3}):/);
    const status =
        (statusMatch ? Number(statusMatch[1]) : null) ??
        (typeof record.statusCode === 'number' ? record.statusCode : null) ??
        (typeof record.data?.status === 'number' ? record.data.status : null);
    if (typeof status === 'number') {
        if (status === 401 || status === 402 || status === 429) return true;
        if (status >= 500) return true;
    }
    return false;
}
