/**
 * Error taxonomy for the gateway.
 *
 * Every failure a layer raises is one of these codes, so routes, the conversation
 * layer and the upstream clients share one vocabulary. The code strings are part
 * of the public HTTP contract (`docs/zh/api-reference.md`): `toOpenAIError` copies
 * them into `error.code`.
 *
 * @module errors/taxonomy
 */

/**
 * Canonical error codes.
 *
 * @readonly
 * @enum {string}
 */
export const ERROR_CODES = Object.freeze({
    /** Malformed request: unparseable body, missing required field, bad value. */
    INVALID_REQUEST: 'invalid_request_error',
    /** The proxy's own bearer key is missing or wrong. */
    INVALID_API_KEY: 'invalid_api_key',
    /** The requested model is unknown or has no usable upstream. */
    MODEL_NOT_FOUND: 'model_not_found',
    /** Upstream credits/balance exhausted (upstream 402). */
    INSUFFICIENT_QUOTA: 'insufficient_quota',
    /** Upstream rate limit (upstream 429). */
    RATE_LIMIT_EXCEEDED: 'rate_limit_exceeded',
    /** The turn exceeded REQUEST_TIMEOUT_MS (upstream 504). */
    TIMEOUT: 'timeout',
    /** Another turn of the same conversation is already in flight. */
    CONVERSATION_BUSY: 'conversation_busy',
    /** The runtime session state could not be read, so the turn cannot be made safe. */
    SESSION_STATE_UNAVAILABLE: 'session_state_unavailable',
    /** Upstream refused the call (upstream 403). */
    PERMISSION_DENIED: 'permission_denied',
    /** Anything unexpected; the message is not exposed to the client. */
    INTERNAL: 'internal_error'
});

/**
 * HTTP status code attached to each error code.
 *
 * @readonly
 * @type {Readonly<Record<string, number>>}
 */
export const ERROR_STATUS_CODES = Object.freeze({
    [ERROR_CODES.INVALID_REQUEST]: 400,
    [ERROR_CODES.INVALID_API_KEY]: 401,
    [ERROR_CODES.MODEL_NOT_FOUND]: 404,
    [ERROR_CODES.INSUFFICIENT_QUOTA]: 402,
    [ERROR_CODES.RATE_LIMIT_EXCEEDED]: 429,
    [ERROR_CODES.TIMEOUT]: 504,
    [ERROR_CODES.CONVERSATION_BUSY]: 503,
    [ERROR_CODES.SESSION_STATE_UNAVAILABLE]: 503,
    [ERROR_CODES.PERMISSION_DENIED]: 403,
    [ERROR_CODES.INTERNAL]: 500
});

/**
 * Public `error.type` value attached to each error code.
 *
 * The documented shapes are not uniform: `conversation_busy` and
 * `session_state_unavailable` are reported as their own type, while validation,
 * auth and not-found failures share `invalid_request_error`, and unexpected
 * failures are `server_error`.
 *
 * @readonly
 * @type {Readonly<Record<string, string>>}
 */
export const ERROR_TYPES = Object.freeze({
    [ERROR_CODES.INVALID_REQUEST]: 'invalid_request_error',
    [ERROR_CODES.INVALID_API_KEY]: 'invalid_request_error',
    [ERROR_CODES.MODEL_NOT_FOUND]: 'invalid_request_error',
    [ERROR_CODES.INSUFFICIENT_QUOTA]: 'insufficient_quota',
    [ERROR_CODES.RATE_LIMIT_EXCEEDED]: 'rate_limit_exceeded',
    [ERROR_CODES.TIMEOUT]: 'timeout',
    [ERROR_CODES.CONVERSATION_BUSY]: 'conversation_busy',
    [ERROR_CODES.SESSION_STATE_UNAVAILABLE]: 'session_state_unavailable',
    [ERROR_CODES.PERMISSION_DENIED]: 'permission_denied',
    [ERROR_CODES.INTERNAL]: 'server_error'
});

/**
 * Options accepted by every {@link GatewayError} subclass.
 *
 * @typedef {object} GatewayErrorOptions
 * @property {string} [code] Error code; defaults to the subclass' code.
 * @property {number} [statusCode] HTTP status; defaults from the code.
 * @property {string} [type] Public `error.type`; defaults from the code.
 * @property {unknown} [details] Diagnostic payload for logs (never sent to clients).
 * @property {boolean} [expose] Whether the message may reach the client.
 * @property {unknown} [cause] Original error, for `Error.cause` chains.
 */

/**
 * Codes whose message is part of the documented response and may reach clients
 * by default. Everything else falls back to "4xx is public, 5xx is private".
 *
 * @type {ReadonlySet<string>}
 */
const EXPOSED_BY_DEFAULT = new Set([
    ERROR_CODES.INVALID_REQUEST,
    ERROR_CODES.INVALID_API_KEY,
    ERROR_CODES.MODEL_NOT_FOUND,
    ERROR_CODES.INSUFFICIENT_QUOTA,
    ERROR_CODES.RATE_LIMIT_EXCEEDED,
    ERROR_CODES.TIMEOUT,
    ERROR_CODES.CONVERSATION_BUSY,
    ERROR_CODES.SESSION_STATE_UNAVAILABLE,
    ERROR_CODES.PERMISSION_DENIED
]);

/**
 * Base class for every error this service raises deliberately.
 *
 * `expose` controls whether `message` may be returned to a client. It defaults to
 * `true` for the documented 4xx codes (and the documented 503s) and to `false`
 * otherwise, so an internal failure never leaks its message unless a caller opts
 * in.
 *
 * @extends Error
 */
export class GatewayError extends Error {
    /**
     * @param {string} message Human-readable description.
     * @param {GatewayErrorOptions} [options] Error metadata.
     */
    constructor(message, options = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });

        const code = options.code ?? ERROR_CODES.INTERNAL;
        const statusCode =
            options.statusCode ?? ERROR_STATUS_CODES[code] ?? ERROR_STATUS_CODES[ERROR_CODES.INTERNAL];

        /** @type {string} Stable machine-readable code (public contract). */
        this.code = code;
        /** @type {number} HTTP status to answer with. */
        this.statusCode = statusCode;
        /** @type {string} Public `error.type` value. */
        this.type = options.type ?? ERROR_TYPES[code] ?? 'server_error';
        /** @type {unknown} Diagnostic details; logged, never exposed. */
        this.details = options.details;
        /** @type {boolean} Whether `message` may be sent to the client. */
        this.expose = options.expose ?? (EXPOSED_BY_DEFAULT.has(code) || statusCode < 500);
        this.name = new.target.name;
    }

    /**
     * Serializable view used by the logger.
     *
     * @returns {{name: string, message: string, code: string, type: string, statusCode: number, details?: unknown}}
     */
    toJSON() {
        return {
            name: this.name,
            message: this.message,
            code: this.code,
            type: this.type,
            statusCode: this.statusCode,
            ...(this.details === undefined ? {} : { details: this.details })
        };
    }
}

/**
 * True when `value` is any error from this taxonomy.
 *
 * @param {unknown} value Value to test.
 * @returns {boolean} Whether `value` is a {@link GatewayError}.
 */
export function isGatewayError(value) {
    return value instanceof GatewayError;
}

/**
 * 400 — the request itself is malformed.
 *
 * @extends GatewayError
 */
export class InvalidRequestError extends GatewayError {
    /**
     * @param {string} [message] Human-readable description.
     * @param {Omit<GatewayErrorOptions, 'code'>} [options] Error metadata.
     */
    constructor(message = 'Invalid request', options = {}) {
        super(message, { ...options, code: ERROR_CODES.INVALID_REQUEST });
    }
}

/**
 * 401 — the caller's bearer key is missing or wrong.
 *
 * @extends GatewayError
 */
export class AuthenticationError extends GatewayError {
    /**
     * @param {string} [message] Human-readable description.
     * @param {Omit<GatewayErrorOptions, 'code'>} [options] Error metadata.
     */
    constructor(message = 'Invalid API key', options = {}) {
        super(message, { ...options, code: ERROR_CODES.INVALID_API_KEY });
    }
}

/**
 * 403 — upstream refused the call (quota plan, free-tier gate, ...).
 *
 * @extends GatewayError
 */
export class PermissionDeniedError extends GatewayError {
    /**
     * @param {string} [message] Human-readable description.
     * @param {Omit<GatewayErrorOptions, 'code'>} [options] Error metadata.
     */
    constructor(message = 'Permission denied', options = {}) {
        super(message, { ...options, code: ERROR_CODES.PERMISSION_DENIED });
    }
}

/**
 * 404 — the requested model cannot be served.
 *
 * @extends GatewayError
 */
export class ModelNotFoundError extends GatewayError {
    /**
     * @param {string} [message] Human-readable description.
     * @param {Omit<GatewayErrorOptions, 'code'>} [options] Error metadata.
     */
    constructor(message = 'Model not found', options = {}) {
        super(message, { ...options, code: ERROR_CODES.MODEL_NOT_FOUND });
    }
}

/**
 * 402 — upstream credits or balance exhausted.
 *
 * @extends GatewayError
 */
export class InsufficientQuotaError extends GatewayError {
    /**
     * @param {string} [message] Human-readable description.
     * @param {Omit<GatewayErrorOptions, 'code'>} [options] Error metadata.
     */
    constructor(message = 'Insufficient quota', options = {}) {
        super(message, { ...options, code: ERROR_CODES.INSUFFICIENT_QUOTA });
    }
}

/**
 * 429 — upstream rate limit.
 *
 * @extends GatewayError
 */
export class RateLimitError extends GatewayError {
    /**
     * @param {string} [message] Human-readable description.
     * @param {Omit<GatewayErrorOptions, 'code'>} [options] Error metadata.
     */
    constructor(message = 'Rate limit exceeded', options = {}) {
        super(message, { ...options, code: ERROR_CODES.RATE_LIMIT_EXCEEDED });
    }
}

/**
 * 504 — the turn exceeded `REQUEST_TIMEOUT_MS`.
 *
 * @extends GatewayError
 */
export class TimeoutError extends GatewayError {
    /**
     * @param {string} [message] Human-readable description.
     * @param {Omit<GatewayErrorOptions, 'code'>} [options] Error metadata.
     */
    constructor(message = 'Request timeout', options = {}) {
        super(message, { ...options, code: ERROR_CODES.TIMEOUT });
    }
}

/**
 * 503 — another turn of the same conversation holds the lock.
 *
 * @extends GatewayError
 */
export class ConversationBusyError extends GatewayError {
    /**
     * @param {string} [message] Human-readable description.
     * @param {Omit<GatewayErrorOptions, 'code'>} [options] Error metadata.
     */
    constructor(message = 'Conversation is busy with another request', options = {}) {
        super(message, { ...options, code: ERROR_CODES.CONVERSATION_BUSY });
    }
}

/**
 * 503 — the runtime session state could not be read.
 *
 * @extends GatewayError
 */
export class SessionStateUnavailableError extends GatewayError {
    /**
     * @param {string} [message] Human-readable description.
     * @param {Omit<GatewayErrorOptions, 'code'>} [options] Error metadata.
     */
    constructor(
        message = 'Could not read the session state for this conversation; retry the request',
        options = {}
    ) {
        super(message, { ...options, code: ERROR_CODES.SESSION_STATE_UNAVAILABLE });
    }
}

/**
 * 500 — anything unexpected. The message is hidden from clients by default.
 *
 * @extends GatewayError
 */
export class InternalError extends GatewayError {
    /**
     * @param {string} [message] Human-readable description.
     * @param {Omit<GatewayErrorOptions, 'code'>} [options] Error metadata.
     */
    constructor(message = 'Internal server error', options = {}) {
        super(message, { ...options, code: ERROR_CODES.INTERNAL, expose: options.expose ?? false });
    }
}
