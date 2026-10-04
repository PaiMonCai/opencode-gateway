/**
 * Structured logger: newline-delimited JSON in production, human-readable when
 * `OPENCODE_PROXY_DEBUG` is on. Secrets are never written.
 *
 * @module logging/logger
 */

/**
 * @typedef {Record<string, unknown>} LogFields
 */

/**
 * Numeric severity per level name.
 *
 * @readonly
 * @type {Readonly<Record<string, number>>}
 */
export const LOG_LEVELS = Object.freeze({
    debug: 10,
    info: 20,
    warn: 30,
    error: 40
});

/** Replacement written in place of a secret value. */
export const REDACTED = '[redacted]';

/**
 * Field names that must never be logged verbatim.
 *
 * @type {RegExp}
 */
const SECRET_KEY_PATTERN =
    /(api[-_]?key|apikey|password|passwd|secret|token|authorization|credential|cookie|private[-_]?key)/i;

/**
 * Field names that merely *mention* a token: usage counters and limits. They are
 * numbers, they are useful in a debug line, and the secret pattern above matched
 * `max_tokens` because it contains `token`.
 *
 * @type {RegExp}
 */
const COUNTER_KEY_PATTERN =
    /^(max_tokens|total_tokens|prompt_tokens|completion_tokens|reasoning_tokens|input_tokens|output_tokens|cached_tokens|tokens)$/i;

/**
 * Whether a field name must be redacted.
 *
 * @param {string} key Field name.
 * @returns {boolean} True when the value is a secret.
 */
export function isSecretKey(key) {
    if (COUNTER_KEY_PATTERN.test(key)) return false;
    return SECRET_KEY_PATTERN.test(key);
}

/** Inline secret shapes scrubbed from otherwise harmless strings. */
const INLINE_SECRET_PATTERNS = Object.freeze([
    /Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
    /\bsk-[A-Za-z0-9_-]{6,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{10,}/g
]);

/**
 * Coerce the extra-fields argument into a plain object.
 *
 * Call sites occasionally pass a string or an `Error` where an object is
 * expected. Spreading those silently produced character-indexed keys
 * (`{0:'R',1:'e',…}`) or an empty record, which is exactly the kind of log line
 * an operator cannot use, so the shape is normalised here.
 *
 * @param {unknown} fields Extra fields from a call site.
 * @returns {LogFields} Plain object that is safe to spread.
 */
export function asLogFields(fields) {
    if (fields === null || fields === undefined) return {};
    // `redact()` turns Errors into `{name, message, stack, cause}`, so keep the
    // value itself instead of flattening it here.
    if (fields instanceof Error) return { error: fields };
    if (Array.isArray(fields) || typeof fields !== 'object') return { detail: fields };
    return /** @type {LogFields} */ (fields);
}

/**
 * @typedef {object} LoggerOptions
 * @property {string | number} [level] Minimum level to emit; defaults to `debug`
 *   when `debug` is true, otherwise `info`.
 * @property {boolean} [debug] Debug mode: raises the level to `debug` and, unless
 *   `json` says otherwise, switches to the human-readable format.
 * @property {boolean} [json] JSON lines when true, human-readable when false.
 *   Defaults to human-readable iff `OPENCODE_PROXY_DEBUG` is truthy.
 * @property {{write: (chunk: string) => unknown}} [stream] Destination; defaults to `process.stderr`.
 * @property {string} [scope] Scope prefix, e.g. `http`.
 * @property {LogFields} [fields] Fields attached to every record.
 */

/**
 * Whether `OPENCODE_PROXY_DEBUG` asks for verbose, human-readable logs.
 *
 * @param {Record<string, string | undefined>} [env] Environment bag.
 * @returns {boolean} True when debug output is requested.
 */
export function isDebugEnabled(env = process.env) {
    const raw = env.OPENCODE_PROXY_DEBUG;
    if (typeof raw !== 'string') return false;
    return ['1', 'true', 'yes', 'y', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Scrub inline credential shapes from a string.
 *
 * @param {string} value Raw string.
 * @returns {string} String with token shapes replaced.
 */
function scrubInlineSecrets(value) {
    let result = value;
    for (const pattern of INLINE_SECRET_PATTERNS) result = result.replace(pattern, REDACTED);
    return result;
}

/**
 * Deep-copy a log value with secrets masked and Errors flattened.
 *
 * @param {unknown} value Value to sanitize.
 * @param {number} [depth] Current recursion depth.
 * @param {WeakSet<object>} [seen] Cycle guard.
 * @returns {unknown} Sanitized value.
 */
export function redact(value, depth = 0, seen = new WeakSet()) {
    if (typeof value === 'string') return scrubInlineSecrets(value);
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Date) return value.toISOString();
    if (depth > 6) return '[truncated]';

    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (value instanceof Error) return serializeError(value, depth, seen);
    if (Array.isArray(value)) {
        return value.slice(0, 100).map((entry) => redact(entry, depth + 1, seen));
    }

    /** @type {Record<string, unknown>} */
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
        output[key] = isSecretKey(key) ? REDACTED : redact(entry, depth + 1, seen);
    }
    return output;
}

/**
 * Flatten an Error for logging, keeping the stack.
 *
 * @param {Error} error Error to flatten.
 * @param {number} [depth] Current recursion depth.
 * @param {WeakSet<object>} [seen] Cycle guard.
 * @returns {Record<string, unknown>} Loggable error view.
 */
export function serializeError(error, depth = 0, seen = new WeakSet()) {
    /** @type {Record<string, unknown>} */
    const view = {
        name: error.name,
        message: scrubInlineSecrets(error.message)
    };
    if (error.stack) view.stack = scrubInlineSecrets(error.stack);
    if (error.cause !== undefined) view.cause = redact(error.cause, depth + 1, seen);
    for (const [key, value] of Object.entries(error)) {
        if (key === 'name' || key === 'message' || key === 'stack') continue;
        view[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(value, depth + 1, seen);
    }
    return view;
}

/**
 * Normalize a level name/number to its numeric rank.
 *
 * @param {string | number} level Level to normalize.
 * @returns {number} Numeric rank; unknown names become `info`.
 */
function levelRank(level) {
    if (typeof level === 'number' && Number.isFinite(level)) return level;
    if (typeof level === 'string' && Object.prototype.hasOwnProperty.call(LOG_LEVELS, level)) {
        return LOG_LEVELS[level];
    }
    return LOG_LEVELS.info;
}

/**
 * Structured logger. Build one per process and derive scoped children.
 *
 * @example
 * const logger = createLogger({ json: true });
 * const http = logger.child('http');
 * http.info('listening', { port: 10000 });
 */
export class Logger {
    /**
     * @param {LoggerOptions} [options] Logger options.
     */
    constructor(options = {}) {
        /**
         * Level as configured. `debug: true` (from `OPENCODE_PROXY_DEBUG`) raises
         * the threshold to `debug` as well: before this, the flag only switched
         * the format and every `log.debug()` record was dropped, which made the
         * debug diagnostics unreadable in production.
         *
         * @type {string | number}
         */
        this.level = options.level ?? (options.debug ? 'debug' : 'info');
        /**
         * Whether records are emitted as JSON lines. The explicit `json` option
         * wins, then the `debug` option, then the environment flag: asking for
         * debug output in the constructor should not silently stay in JSON.
         *
         * @type {boolean}
         */
        this.json = options.json ?? !(options.debug ?? isDebugEnabled());
        /** @type {{write: (chunk: string) => unknown}} Output sink. */
        this.stream = options.stream ?? process.stderr;
        /** @type {string} Scope prefix. */
        this.scope = options.scope ?? '';
        /** @type {LogFields} Fields attached to every record. */
        this.fields = asLogFields(options.fields);
        /** @type {number} Numeric threshold derived from {@link Logger.level}. */
        this.threshold = levelRank(this.level);
    }

    /**
     * Derive a child logger with a deeper scope and/or extra fields.
     *
     * @param {string} scope Scope segment (joined to the parent scope with `:`).
     * @param {LogFields} [fields] Additional fields for the child.
     * @returns {Logger} Child logger sharing this logger's stream.
     */
    child(scope, fields = {}) {
        return new Logger({
            level: this.level,
            json: this.json,
            stream: this.stream,
            scope: this.scope ? `${this.scope}:${scope}` : scope,
            fields: { ...this.fields, ...asLogFields(fields) }
        });
    }

    /**
     * Emit a debug record.
     *
     * @param {string} message Log message.
     * @param {LogFields} [fields] Extra fields.
     * @returns {void}
     */
    debug(message, fields) {
        this.log('debug', message, fields);
    }

    /**
     * Emit an info record.
     *
     * @param {string} message Log message.
     * @param {LogFields} [fields] Extra fields.
     * @returns {void}
     */
    info(message, fields) {
        this.log('info', message, fields);
    }

    /**
     * Emit a warning record.
     *
     * @param {string} message Log message.
     * @param {LogFields} [fields] Extra fields.
     * @returns {void}
     */
    warn(message, fields) {
        this.log('warn', message, fields);
    }

    /**
     * Emit an error record. Pass `{ err }` to include a stack.
     *
     * @param {string} message Log message.
     * @param {LogFields} [fields] Extra fields.
     * @returns {void}
     */
    error(message, fields) {
        this.log('error', message, fields);
    }

    /**
     * Emit one record if it passes the level threshold.
     *
     * @param {string} level Level name.
     * @param {string} message Log message.
     * @param {LogFields} [fields] Extra fields.
     * @returns {void}
     */
    log(level, message, fields = {}) {
        const rank = levelRank(level);
        if (rank < this.threshold) return;

        const record = redact({ ...this.fields, ...asLogFields(fields) });
        const line = this.json
            ? `${JSON.stringify({
                  .../** @type {Record<string, unknown>} */ (record),
                  ts: new Date().toISOString(),
                  level,
                  ...(this.scope ? { scope: this.scope } : {}),
                  msg: scrubInlineSecrets(String(message))
              })}\n`
            : this.#formatHuman(level, message, /** @type {Record<string, unknown>} */ (record));

        this.stream.write(line);
    }

    /**
     * Render a human-readable single record.
     *
     * @param {string} level Level name.
     * @param {string} message Log message.
     * @param {Record<string, unknown>} fields Sanitized fields.
     * @returns {string} Line including the trailing newline.
     */
    #formatHuman(level, message, fields) {
        const parts = [
            new Date().toISOString(),
            level.toUpperCase().padEnd(5),
            this.scope ? `[${this.scope}]` : null,
            scrubInlineSecrets(String(message))
        ].filter(Boolean);
        const extra = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
        return `${parts.join(' ')}${extra}\n`;
    }
}

/**
 * Create a {@link Logger}.
 *
 * @param {LoggerOptions} [options] Logger options.
 * @returns {Logger} Logger instance.
 */
export function createLogger(options = {}) {
    return new Logger(options);
}
