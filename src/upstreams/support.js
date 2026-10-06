import { createLogger } from '../logging/index.js';

/**
 * Internal helpers of the upstream layer. Configuration is read only from the
 * injected `config` (never `process.env`); logging goes through the injected
 * `logger`, falling back to `src/logging`.
 *
 * @typedef {import('../logging/index.js').Logger} Logger
 */

/**
 * Normalise any supported logger value into a `Logger`.
 *
 * Accepted inputs:
 * - a `Logger` from `src/logging` (a scope child is derived when supported),
 * - a bare `(message, fields) => void` function from an existing caller (used as
 *   `debug` on every level),
 * - `null`/`undefined`, which falls back to an error-level logger so a module
 *   used without wiring never writes informational noise.
 *
 * @param {any} [logger]
 *   Injected logger (a `Logger`, a `(message, fields) => void` function, or nothing).
 * @param {string} [scope] Scope attached to the records.
 * @returns {Logger} A logger that never throws.
 */
export function resolveLogger(logger, scope) {
    if (logger && typeof logger.child === 'function') return logger.child(scope);
    if (logger && typeof logger.debug === 'function') return logger;
    if (typeof logger === 'function') {
        return /** @type {any} */ ({
            debug: logger,
            info: logger,
            warn: logger,
            error: logger,
            child: () => resolveLogger(logger, scope)
        });
    }
    return createLogger({ level: 'error', scope });
}

/**
 * Coerce the boolean-ish values the environment hands us (`'false'`, `'0'`, ...).
 *
 * @param {*} value Raw value from the injected config.
 * @returns {boolean|null} `true`/`false`, or `null` when the value is absent.
 */
export function toBool(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(text)) return true;
    if (['0', 'false', 'no', 'off'].includes(text)) return false;
    return null;
}

/**
 * Coerce a positive millisecond count.
 *
 * @param {*} value Raw value from the injected config.
 * @param {number} fallback Value used when `value` is missing or not positive.
 * @returns {number} Milliseconds.
 */
export function toMillis(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve after `ms` milliseconds.
 *
 * @param {number} ms Delay.
 * @returns {Promise<void>} Resolves after the delay.
 */
export const sleep = (ms) =>
    new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        if (typeof timer.unref === 'function') timer.unref();
    });
