/**
 * Runtime retry policy and session rotation.
 *
 * Owns generic retry decisions and replacing a failed runtime session; turn-specific
 * state (prompt history, tool requesters, streaming buffers) stays in the orchestrator.
 *
 * @module routes/runtime-retry
 */

import { isTransientUpstreamError } from '../errors/index.js';

/** Backoff base used for retries: attempt 2 waits 1600ms, attempt 3 waits 2400ms. */
export const DEFAULT_RUNTIME_RETRY_BACKOFF_BASE_MS = 800;
/** Maximum number of runtime attempts for a single client turn. */
export const DEFAULT_RUNTIME_RETRY_MAX_ATTEMPTS = 3;

/**
 * @typedef {object} RuntimeErrorLike
 * @property {string} [name]
 * @property {string} [message]
 * @property {{message?: string}} [data]
 */

/**
 * Decide whether one failed runtime attempt is safe to retry: only transient
 * upstream failures that produced no client-visible output. Retrying after any
 * content or tool progress could duplicate output.
 *
 * @param {object} options Retry state.
 * @param {RuntimeErrorLike|null|undefined} options.error Attempt error.
 * @param {boolean} options.hasOutput Whether any usable output was produced.
 * @param {number} options.attempt Current 1-based attempt number.
 * @param {number} [options.maxAttempts] Maximum attempts.
 * @returns {boolean} True when the caller should rotate the session and retry.
 */
export function shouldRetryRuntimeAttempt({
    error,
    hasOutput,
    attempt,
    maxAttempts = DEFAULT_RUNTIME_RETRY_MAX_ATTEMPTS
}) {
    return Boolean(error && !hasOutput && attempt < maxAttempts && isTransientUpstreamError(error));
}

/**
 * Produce a compact retry log detail from a runtime error.
 *
 * @param {RuntimeErrorLike|null|undefined} error Runtime error.
 * @returns {string} Human-readable detail.
 */
export function runtimeRetryDetail(error) {
    return error?.data?.message || error?.message || error?.name || 'unknown';
}

/**
 * Delete a failed runtime session, create a replacement, then apply bounded
 * backoff. Deletion is best-effort: a stale failed session must not prevent the
 * current turn from recovering.
 *
 * @param {object} options Rotation dependencies.
 * @param {string} options.sessionId Current failed session.
 * @param {(sessionId: string) => Promise<unknown>} options.deleteSession Session delete adapter.
 * @param {() => Promise<string>} options.createSession Session create adapter.
 * @param {number} options.attempt New 1-based attempt number.
 * @param {number} [options.backoffBaseMs] Backoff base.
 * @param {(ms: number) => Promise<void>} options.sleepFn Sleep adapter.
 * @param {(message: string, fields?: Record<string, unknown>) => void} [options.logDebug] Debug logger.
 * @returns {Promise<string>} Newly created session id.
 */
export async function rotateRuntimeSession({
    sessionId,
    deleteSession,
    createSession,
    attempt,
    backoffBaseMs = DEFAULT_RUNTIME_RETRY_BACKOFF_BASE_MS,
    sleepFn,
    logDebug = () => {}
}) {
    try {
        await deleteSession(sessionId);
    } catch (error) {
        logDebug('Failed to delete retried session', {
            sessionId,
            error: error instanceof Error ? error.message : String(error)
        });
    }

    const nextSessionId = await createSession();
    await sleepFn(backoffBaseMs * attempt);
    return nextSessionId;
}
