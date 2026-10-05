/**
 * Lifecycle wrapper for the Responses API previous_response_id index.
 *
 * Owns the periodic sweep for response-chain state and the conversation
 * registry so the turn engine does not manage background timers directly.
 *
 * @module routes/response-chain-service
 */

const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * @param {object} options Service dependencies.
 * @param {any} options.responseChains Response chain index.
 * @param {any} options.registry Conversation registry.
 * @param {number} [options.sweepIntervalMs] Periodic sweep interval.
 * @param {boolean} [options.schedule] Whether to start the periodic timer.
 * @returns {{
 *   getResponseState: (responseId: string) => any|null,
 *   storeResponseState: (responseId: string, sessionId: string, model: string) => void,
 *   sweep: () => Promise<void>,
 *   close: () => void
 * }}
 */
export function createResponseChainService({
    responseChains,
    registry,
    sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
    schedule = true
}) {
    if (!responseChains || typeof responseChains.get !== 'function') {
        throw new Error('createResponseChainService requires a response-chain index');
    }
    if (!registry || typeof registry.sweep !== 'function') {
        throw new Error('createResponseChainService requires a conversation registry');
    }

    /** @type {(responseId: string) => any|null} */
    const getResponseState = (responseId) => responseChains.get(responseId);
    /** @type {(responseId: string, sessionId: string, model: string) => void} */
    const storeResponseState = (responseId, sessionId, model) =>
        responseChains.store(responseId, sessionId, model);

    const sweep = async () => {
        await Promise.all([
            Promise.resolve(responseChains.sweep()).catch(() => {}),
            Promise.resolve(registry.sweep()).catch(() => {})
        ]);
    };

    /** @type {ReturnType<typeof setInterval>|null} */
    let timer = null;
    if (schedule) {
        timer = setInterval(() => {
            sweep().catch(() => {});
        }, sweepIntervalMs);
        if (typeof timer.unref === 'function') timer.unref();
    }

    return {
        getResponseState,
        storeResponseState,
        sweep,
        close() {
            if (!timer) return;
            clearInterval(timer);
            timer = null;
        }
    };
}
