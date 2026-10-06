/**
 * Thin adapter around the runtime-client turn primitives.
 *
 * No retry or reconciliation policy lives here; the engine stays an assembly layer.
 *
 * @module routes/runtime-service
 */

/**
 * @param {any} runtime Runtime upstream adapter.
 * @returns {{
 *   promptWithTimeout: (promptParams: any, timeoutMs: number, signal?: AbortSignal|null) => Promise<any>,
 *   pollForAssistantResponse: (sessionId: string, timeoutMs: number, intervalMs: number, baseline?: any|null) => Promise<any>,
 *   collectFromEvents: (sessionId: string, timeoutMs: number, onDelta: (delta: string, isReasoning?: boolean) => void, firstDeltaTimeoutMs: number, idleTimeoutMs: number, baseline?: any|null, externalSignal?: AbortSignal|null) => Promise<any>
 * }}
 */
export function createRuntimeTurnService(runtime) {
    if (!runtime) throw new Error('createRuntimeTurnService requires a runtime upstream');

    /** @type {(promptParams: any, timeoutMs: number, signal?: AbortSignal|null) => Promise<any>} */
    const promptWithTimeout = (promptParams, timeoutMs, signal = null) =>
        Promise.resolve(runtime.prompt(promptParams, { timeoutMs, signal }));

    /** @type {(sessionId: string, timeoutMs: number, intervalMs: number, baseline?: any|null) => Promise<any>} */
    const pollForAssistantResponse = (sessionId, timeoutMs, intervalMs, baseline = null) =>
        Promise.resolve(runtime.pollForAssistantResponse({ sessionId, timeoutMs, intervalMs, baseline }));

    /** @type {(sessionId: string, timeoutMs: number, onDelta: (delta: string, isReasoning?: boolean) => void, firstDeltaTimeoutMs: number, idleTimeoutMs: number, baseline?: any|null, externalSignal?: AbortSignal|null) => Promise<any>} */
    const collectFromEvents = (
        sessionId,
        timeoutMs,
        onDelta,
        firstDeltaTimeoutMs,
        idleTimeoutMs,
        baseline = null,
        externalSignal = null
    ) =>
        Promise.resolve(
            runtime.collectFromEvents({
                sessionId,
                timeoutMs,
                onDelta,
                firstDeltaTimeoutMs,
                idleTimeoutMs,
                baseline,
                signal: externalSignal
            })
        );

    return {
        promptWithTimeout,
        pollForAssistantResponse,
        collectFromEvents
    };
}
