/**
 * Mechanical runtime attempt execution.
 *
 * These helpers only coordinate prompt dispatch with observation. They do not
 * decide retries, rotate sessions, parse tools, or interpret completion state.
 *
 * @module routes/runtime-attempt
 */

/**
 * Start event collection before dispatching the prompt, preserving the ordering
 * required to avoid missing early runtime events.
 *
 * Collector rejections are normalized into `{__error}`; synchronous setup
 * failures still throw so the caller can preserve its surface-specific behavior.
 *
 * @param {object} options Attempt dependencies.
 * @param {() => Promise<object>} options.collect Event collector factory.
 * @param {() => Promise<unknown>} options.prompt Prompt dispatch.
 * @param {(error: Error) => void} [options.onPromptError] Async prompt error observer.
 * @returns {Promise<object>} Collector result or `{__error}`.
 */
export async function collectRuntimePromptAttempt({ collect, prompt, onPromptError = () => {} }) {
    const collectPromise = collect();
    const safeCollect = collectPromise.catch((error) => ({ __error: error }));
    prompt().catch((error) => onPromptError(error instanceof Error ? error : new Error(String(error))));
    return safeCollect;
}

/**
 * Dispatch one prompt, log its latency, then poll the authoritative session
 * snapshot for the completed answer.
 *
 * @param {object} options Attempt dependencies.
 * @param {() => Promise<unknown>} options.prompt Prompt dispatch.
 * @param {() => Promise<object>} options.poll Poll factory.
 * @param {string} options.sessionId Session id used for diagnostics.
 * @param {number} options.attempt 1-based attempt number.
 * @param {(message: string, fields?: Record<string, unknown>) => void} [options.logDebug] Debug logger.
 * @param {() => number} [options.now] Clock for latency measurement.
 * @returns {Promise<object>} Poll result.
 */
export async function runPolledRuntimeAttempt({
    prompt,
    poll,
    sessionId,
    attempt,
    logDebug = () => {},
    now = Date.now
}) {
    const startedAt = now();
    await prompt();
    logDebug('Prompt sent', { sessionId, ms: now() - startedAt, attempt });
    return poll();
}
